import jsonpatch, { type Operation } from 'fast-json-patch';
import { z } from 'zod';
import { canonicalBytes, canonicalString, hashObject, isHash, sha256Hash } from './canonical.ts';
import type { Budgets, DecisionKind, ErrorCode, Hash, JsonPatchOp, Party, Plan, SectionType } from './types.ts';
import { DECISION_KINDS, PLAN_SCHEMA } from './types.ts';

const hash = z.custom<Hash>((value) => isHash(value), { message: 'expected sha256:<64 hex>' });
const party = z.enum(['A', 'B']);
const owner = z.enum(['A', 'B', 'joint']);
const decisionKind = z.enum(DECISION_KINDS as [DecisionKind, ...DecisionKind[]]);
const sectionType: z.ZodType<SectionType> = z.union([
  z.enum(['prose', 'interface', 'data_schema', 'migration', 'rollout', 'ownership', 'risks', 'checklist']),
  z.custom<`custom:${string}`>((value) => typeof value === 'string' && value.startsWith('custom:'), {
    message: 'expected a known section type or custom:<uri>',
  }),
]);
const itemId = z.string().min(1);

const artifact = z
  .object({ name: z.string().min(1), format: z.string().min(1), content: z.string(), sha256: hash })
  .strict();

const section = z
  .object({
    id: itemId,
    title: z.string(),
    type: sectionType,
    owner,
    md: z.string(),
    artifacts: z.array(artifact).optional(),
  })
  .strict();

const decision = z
  .object({
    id: itemId,
    text: z.string(),
    kind: decisionKind.optional(),
    decided_by: z.enum(['human-A', 'human-B', 'agent-assumed']),
    decided_in: hash.nullable(),
  })
  .strict();

const disagreement = z.object({ id: itemId, text: z.string(), resolution: z.string() }).strict();

const openItem = z
  .object({
    id: itemId,
    text: z.string(),
    blocking: z.boolean(),
    owner,
    status: z.enum(['open', 'resolved', 'deferred']),
  })
  .strict();

const actionItem = z.object({ id: itemId, text: z.string() }).strict();

const planObject = z
  .object({
    schema: z.literal(PLAN_SCHEMA),
    session: z.string().min(1),
    version: z.number().int().nonnegative(),
    parent: hash.nullable(),
    meta: z
      .object({
        title: z.string(),
        type: z.enum(['contract', 'impact', 'plan', 'question']),
        parties: z.object({ A: z.string(), B: z.string() }).strict(),
        charter_hash: hash,
      })
      .strict(),
    sections: z.array(section),
    decisions: z.array(decision),
    disagreements: z.array(disagreement),
    open_items: z.array(openItem),
    action_items: z.object({ A: z.array(actionItem), B: z.array(actionItem) }).strict(),
  })
  .strict();

function requireUniqueIds(items: { id: string }[], path: (string | number)[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, index, 'id'], message: `duplicate id ${item.id}` });
    seen.add(item.id);
  });
}

/** Strict plan schema. Item ids are unique within each list, since sections and decisions are compared by id. */
export const PlanSchema: z.ZodType<Plan> = planObject.superRefine((plan, ctx) => {
  requireUniqueIds(plan.sections, ['sections'], ctx);
  requireUniqueIds(plan.decisions, ['decisions'], ctx);
  requireUniqueIds(plan.disagreements, ['disagreements'], ctx);
  requireUniqueIds(plan.open_items, ['open_items'], ctx);
  requireUniqueIds(plan.action_items.A, ['action_items', 'A'], ctx);
  requireUniqueIds(plan.action_items.B, ['action_items', 'B'], ctx);
});

export function planHash(plan: Plan): Hash {
  return hashObject(plan);
}

export type ApplyResult =
  | { ok: true; plan: Plan; hash: Hash; effectiveKinds: DecisionKind[] }
  | { ok: false; code: ErrorCode; detail: string };

const patchOp = z
  .object({
    op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
    path: z.string(),
    value: z.unknown().optional(),
    from: z.string().optional(),
  })
  .strict();

const PROTECTED_PATHS: string[][] = [['schema'], ['session'], ['version'], ['parent'], ['meta', 'charter_hash'], ['meta', 'parties']];

/** RFC 6901 pointer to reference tokens; null when the pointer is malformed. */
function pointerTokens(pointer: string): string[] | null {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return null;
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function isPrefix(prefix: string[], of: string[]): boolean {
  return prefix.length <= of.length && prefix.every((token, i) => token === of[i]);
}

/** Writing to an ancestor of a protected path (e.g. `/meta` or the root) rewrites it too. */
function touchesProtected(tokens: string[]): boolean {
  return PROTECTED_PATHS.some((p) => isPrefix(p, tokens) || isPrefix(tokens, p));
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalString(a) === canonicalString(b);
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

/** Kinds of every decision whose content differs between the two plans (added, changed or removed), before and after. */
function changedDecisionKinds(before: Plan, after: Plan): Set<DecisionKind> {
  const kinds = new Set<DecisionKind>();
  const old = byId(before.decisions);
  const now = byId(after.decisions);
  for (const id of new Set([...old.keys(), ...now.keys()])) {
    const a = old.get(id);
    const b = now.get(id);
    if (sameJson(a, b)) continue;
    if (a?.kind) kinds.add(a.kind);
    if (b?.kind) kinds.add(b.kind);
  }
  return kinds;
}

function ownerViolation(before: Plan, after: Plan, by: Party): string | null {
  const other: Party = by === 'A' ? 'B' : 'A';
  const old = byId(before.sections);
  const now = byId(after.sections);
  for (const id of new Set([...old.keys(), ...now.keys()])) {
    const a = old.get(id);
    const b = now.get(id);
    if ((a?.owner === other || b?.owner === other) && !sameJson(a, b)) {
      return `section ${id} is owned by ${other}`;
    }
  }
  const decisions = byId(before.decisions);
  for (const d of after.decisions) {
    if (d.decided_by === `human-${other}` && !sameJson(decisions.get(d.id), d)) {
      return `decision ${d.id} cannot be attributed to human-${other} by ${by}`;
    }
  }
  return null;
}

function sortKinds(kinds: Iterable<DecisionKind>): DecisionKind[] {
  const set = new Set(kinds);
  return DECISION_KINDS.filter((kind) => set.has(kind));
}

/** Checks a whole plan against the schema, artifact hashes and the size budget. */
export function checkPlan(plan: unknown, maxPlanBytes: number): { ok: true; plan: Plan } | { ok: false; code: 'BAD_PATCH' | 'TOO_LARGE'; detail: string } {
  const parsed = PlanSchema.safeParse(plan);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, code: 'BAD_PATCH', detail: `plan schema: ${issue ? `${issue.path.join('/')}: ${issue.message}` : 'invalid'}` };
  }
  const valid = plan as Plan;
  for (const s of valid.sections) {
    for (const a of s.artifacts ?? []) {
      if (sha256Hash(a.content) !== a.sha256) {
        return { ok: false, code: 'BAD_PATCH', detail: `artifact ${a.name} in section ${s.id}: sha256 does not match content` };
      }
    }
  }
  const size = canonicalBytes(valid).length;
  if (size > maxPlanBytes) return { ok: false, code: 'TOO_LARGE', detail: `plan is ${size} bytes, limit ${maxPlanBytes}` };
  return { ok: true, plan: valid };
}

/** Validates a proposal's patch against `plan` and computes the next version (§2.5) and its computed decision kinds (§2.6). */
export function applyProposal(plan: Plan, patch: JsonPatchOp[], by: Party, budgets: Budgets): ApplyResult {
  const ops = z.array(patchOp).safeParse(patch);
  if (!ops.success) return { ok: false, code: 'BAD_PATCH', detail: 'patch is not a list of JSON Patch operations' };
  const list = JSON.parse(JSON.stringify(ops.data)) as JsonPatchOp[];

  const first = list[0];
  if (!first || first.op !== 'test' || first.path !== '/version' || !('value' in first)) {
    return { ok: false, code: 'BAD_PATCH', detail: 'patch must begin with a test of /version' };
  }
  if (first.value !== plan.version) {
    return { ok: false, code: 'STALE_BASE', detail: `patch tests version ${JSON.stringify(first.value)}, plan is at ${plan.version}` };
  }

  for (const [index, op] of list.entries()) {
    const path = pointerTokens(op.path);
    if (path === null) return { ok: false, code: 'BAD_PATCH', detail: `op ${index}: malformed path` };
    if (op.op === 'test') continue;
    const from = op.op === 'move' && op.from !== undefined ? pointerTokens(op.from) : [];
    if (from === null) return { ok: false, code: 'BAD_PATCH', detail: `op ${index}: malformed from` };
    if (touchesProtected(path) || (op.op === 'move' && touchesProtected(from))) {
      return { ok: false, code: 'BAD_PATCH', detail: `op ${index}: ${op.op} ${op.op === 'move' ? `${op.from} -> ` : ''}${op.path} touches a protected path` };
    }
  }

  let next: unknown;
  try {
    next = jsonpatch.applyPatch(plan, list as Operation[], true, false).newDocument;
  } catch (error) {
    const name = error instanceof Error ? error.name : 'error';
    return { ok: false, code: 'BAD_PATCH', detail: `patch does not apply: ${name}` };
  }
  if (typeof next !== 'object' || next === null || Array.isArray(next)) {
    return { ok: false, code: 'BAD_PATCH', detail: 'patch result is not an object' };
  }
  const candidate = { ...(next as Plan), version: plan.version + 1, parent: planHash(plan) };

  const checked = checkPlan(candidate, budgets.max_plan_bytes);
  if (!checked.ok) return checked;
  const violation = ownerViolation(plan, checked.plan, by);
  if (violation) return { ok: false, code: 'OWNER_VIOLATION', detail: violation };

  return {
    ok: true,
    plan: checked.plan,
    hash: planHash(checked.plan),
    effectiveKinds: sortKinds(changedDecisionKinds(plan, checked.plan)),
  };
}
