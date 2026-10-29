import jsonpatch, { type Operation } from 'fast-json-patch';
import { z } from 'zod';
import { canonicalBytes, canonicalString, hashObject, isHash, sha256Hash } from './canonical.ts';
import type { Budgets, DecisionKind, ErrorCode, Hash, JsonPatchOp, Party, Plan, SectionType } from './types.ts';
import { DECISION_KINDS, PLAN_SCHEMA } from './types.ts';

const hash = z.custom<Hash>((value) => isHash(value), { message: 'expected sha256:<64 hex>' });
const party = z.enum(['A', 'B']);
const owner = z.enum(['A', 'B', 'joint']);
const decisionKind = z.enum(DECISION_KINDS as [DecisionKind, ...DecisionKind[]]);

/**
 * C0 controls other than tab and line feed, C1 controls, zero-width and bidi format characters, the BOM, and
 * unpaired UTF-16 surrogates: they hide or reorder rendered text, and an unpaired surrogate does not survive UTF-8.
 */
const UNSAFE_CHARACTER =
  /[\u0000-\u0008\u000B-\u001F\u0080-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isSafeText(value: string): boolean {
  return !UNSAFE_CHARACTER.test(value);
}

const UNSAFE_MESSAGE = 'contains a control, format or unpaired surrogate character';
const text = z.string().refine(isSafeText, { message: UNSAFE_MESSAGE });
const nonEmptyText = z.string().min(1).refine(isSafeText, { message: UNSAFE_MESSAGE });
const sectionType: z.ZodType<SectionType> = z.union([
  z.enum(['prose', 'interface', 'data_schema', 'migration', 'rollout', 'ownership', 'risks', 'checklist']),
  z.custom<`custom:${string}`>((value) => typeof value === 'string' && value.startsWith('custom:') && isSafeText(value), {
    message: 'expected a known section type or custom:<uri>',
  }),
]);
const itemId = nonEmptyText;

const artifact = z
  .object({ name: nonEmptyText, format: nonEmptyText, content: text, sha256: hash })
  .strict();

const section = z
  .object({
    id: itemId,
    title: text,
    type: sectionType,
    owner,
    md: text,
    artifacts: z.array(artifact).optional(),
  })
  .strict();

const decision = z
  .object({
    id: itemId,
    text,
    kind: decisionKind.optional(),
    decided_by: z.enum(['human-A', 'human-B', 'agent-assumed']),
    decided_in: hash.nullable(),
  })
  .strict();

const disagreement = z.object({ id: itemId, text, resolution: text }).strict();

const openItem = z
  .object({
    id: itemId,
    text,
    blocking: z.boolean(),
    owner,
    status: z.enum(['open', 'resolved', 'deferred']),
  })
  .strict();

const actionItem = z.object({ id: itemId, text }).strict();

const planObject = z
  .object({
    schema: z.literal(PLAN_SCHEMA),
    session: nonEmptyText,
    version: z.number().int().nonnegative(),
    parent: hash.nullable(),
    meta: z
      .object({
        title: text,
        type: z.enum(['contract', 'impact', 'plan', 'question', 'sync']),
        parties: z.object({ A: text, B: text }).strict(),
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
  | { ok: true; plan: Plan; hash: Hash; effectiveKinds: DecisionKind[]; changedDecisions: string[] }
  | { ok: false; code: ErrorCode; detail: string };

export const MAX_PATCH_OPS = 200;

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

/** Ids of decisions whose content differs between the two plans (added, changed or removed), and their kinds before and after. */
function changedDecisions(before: Plan, after: Plan): { ids: string[]; kinds: Set<DecisionKind> } {
  const ids: string[] = [];
  const kinds = new Set<DecisionKind>();
  const old = byId(before.decisions);
  const now = byId(after.decisions);
  for (const id of new Set([...old.keys(), ...now.keys()])) {
    const a = old.get(id);
    const b = now.get(id);
    if (sameJson(a, b)) continue;
    ids.push(id);
    if (a?.kind) kinds.add(a.kind);
    if (b?.kind) kinds.add(b.kind);
  }
  return { ids, kinds };
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
  const theirs = `human-${other}`;
  const oldDecisions = byId(before.decisions);
  const newDecisions = byId(after.decisions);
  for (const id of new Set([...oldDecisions.keys(), ...newDecisions.keys()])) {
    const a = oldDecisions.get(id);
    const b = newDecisions.get(id);
    if (sameJson(a, b)) continue;
    if (a?.decided_by === theirs) return `decision ${id} was decided by ${theirs} and cannot be ${b ? 'changed' : 'removed'} by ${by}`;
    if (b?.decided_by === theirs) return `decision ${id} cannot be attributed to ${theirs} by ${by}`;
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

/**
 * Applies ops one at a time to a copy of `plan`, failing as soon as the document outgrows `maxPlanBytes`.
 * A `copy` can double the document, so checking only the final result would let a short patch do exponential work.
 */
function applyOps(plan: Plan, ops: JsonPatchOp[], maxPlanBytes: number): { ok: true; doc: unknown } | { ok: false; code: ErrorCode; detail: string } {
  let doc: unknown = jsonpatch.deepClone(plan);
  for (const [index, op] of ops.entries()) {
    try {
      doc = jsonpatch.applyOperation(doc, op as Operation, true, true, true, index).newDocument;
    } catch (error) {
      const name = error instanceof Error ? error.name : 'error';
      return { ok: false, code: 'BAD_PATCH', detail: `patch does not apply: ${name} at op ${index}` };
    }
    const size = canonicalBytes(doc).length;
    if (size > maxPlanBytes) return { ok: false, code: 'TOO_LARGE', detail: `plan is ${size} bytes after op ${index}, limit ${maxPlanBytes}` };
  }
  return { ok: true, doc };
}

/** Validates a proposal's patch against `plan` and computes the next version (§2.5) and the decisions it changes (§2.6). */
export function applyProposal(plan: Plan, patch: JsonPatchOp[], by: Party, budgets: Budgets): ApplyResult {
  const ops = z.array(patchOp).safeParse(patch);
  if (!ops.success) return { ok: false, code: 'BAD_PATCH', detail: 'patch is not a list of JSON Patch operations' };
  if (ops.data.length > MAX_PATCH_OPS) return { ok: false, code: 'BAD_PATCH', detail: `patch has ${ops.data.length} ops, limit ${MAX_PATCH_OPS}` };
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

  const applied = applyOps(plan, list, budgets.max_plan_bytes);
  if (!applied.ok) return applied;
  const next = applied.doc;
  if (typeof next !== 'object' || next === null || Array.isArray(next)) {
    return { ok: false, code: 'BAD_PATCH', detail: 'patch result is not an object' };
  }
  const candidate = { ...(next as Plan), version: plan.version + 1, parent: planHash(plan) };

  const checked = checkPlan(candidate, budgets.max_plan_bytes);
  if (!checked.ok) return checked;
  const violation = ownerViolation(plan, checked.plan, by);
  if (violation) return { ok: false, code: 'OWNER_VIOLATION', detail: violation };

  const changed = changedDecisions(plan, checked.plan);
  return {
    ok: true,
    plan: checked.plan,
    hash: planHash(checked.plan),
    effectiveKinds: sortKinds(changed.kinds),
    changedDecisions: changed.ids,
  };
}
