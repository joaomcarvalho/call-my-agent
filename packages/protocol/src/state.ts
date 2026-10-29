import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { canonicalString, hashObject, isHash, sha256Hash } from './canonical.ts';
import { ChainTracker } from './chain.ts';
import { verifyEnvelope } from './envelope.ts';
import { isKeyId, verifyObject } from './keys.ts';
import { applyProposal, checkPlan, planHash } from './plan.ts';
import { markdownHash } from './render.ts';
import { createPlanV0 } from './templates.ts';
import type {
  Budgets,
  Charter,
  DecisionKind,
  Envelope,
  ErrorCode,
  Hash,
  Identity,
  JsonPatchOp,
  KeyId,
  MessageType,
  Party,
  Plan,
  SessionState,
  SignoffStatement,
} from './types.ts';
import { DECISION_KINDS, PROTOCOL_VERSION } from './types.ts';

export interface ReplayOptions {
  joinSecret?: Uint8Array;
  /** ISO-8601 time at which the log is evaluated; drives EXPIRED. */
  now?: string;
}

export interface PendingProposal {
  id: Hash;
  from: Party;
  type: 'propose' | 'counter' | 'amend';
  patch: JsonPatchOp[];
  kinds: DecisionKind[];
  /** Whether proposer and accepter must cite a checkpoint answer (§2.6). */
  checkpoint: boolean;
  resultHash: Hash;
  baseVersion: number;
}

export interface ReplayResult {
  state: SessionState;
  charter: Charter | null;
  charterHash: Hash | null;
  identities: Partial<Record<Party, Identity>>;
  plan: Plan | null;
  planHash: Hash | null;
  version: number;
  pending: PendingProposal | null;
  signoffRequest: { id: Hash; from: Party; version: number; hash: Hash; mdHash: Hash } | null;
  frozen: { version: number; hash: Hash; mdHash: Hash } | null;
  signoffs: Partial<Record<Party, { id: Hash; statement: SignoffStatement; human_sig: string }>>;
  final: { id: Hash; planHash: Hash } | null;
  stored: Partial<Record<Party, Hash>>;
  floor: Party | null;
  turns: Record<Party, number>;
  turnBudget: Record<Party, number>;
  proposals: number;
  noProgress: number;
  nudge: boolean;
  counterStreak: number;
  deadlockReason: string | null;
  awaitingHuman: Record<Party, boolean>;
  checkpoints: Record<string, { party: Party; askedIn: Hash; answeredIn: Hash | null }>;
  rejectedHashes: Hash[];
  /** ids applied, in order */
  accepted: Hash[];
  rejected: { id: Hash; code: ErrorCode; detail: string }[];
  /** for building the next envelope */
  lastSeq: Record<Party, number>;
  lastId: Record<Party, Hash | null>;
  /** `ts` of the accepted welcome; open states expire `budgets.ttl_s` after it. */
  welcomedAt: string | null;
}

// ---------------------------------------------------------------- schemas

const ERROR_CODES: Record<ErrorCode, true> = {
  BAD_SCHEMA: true,
  BAD_SIGNATURE: true,
  BAD_ID: true,
  UNKNOWN_SENDER: true,
  CHAIN_GAP: true,
  CHAIN_DUPLICATE: true,
  CHAIN_FORK: true,
  NOT_YOUR_FLOOR: true,
  PROPOSAL_PENDING: true,
  NO_SUCH_PROPOSAL: true,
  STALE_BASE: true,
  BAD_PATCH: true,
  OWNER_VIOLATION: true,
  BUDGET_EXHAUSTED: true,
  INVALID_STATE: true,
  CHARTER_MISMATCH: true,
  JOIN_PROOF_INVALID: true,
  IDENTITY_INSUFFICIENT: true,
  MODE_VIOLATION: true,
  CHECKPOINT_SKIPPED: true,
  RECREATES_REJECTED: true,
  SIGNOFF_MISMATCH: true,
  TOO_LARGE: true,
};

const SESSION_STATES: Record<SessionState, 'open' | 'terminal'> = {
  INVITED: 'open',
  HANDSHAKE: 'open',
  DISCUSSING: 'open',
  PROPOSAL_PENDING: 'open',
  FROZEN: 'open',
  AGREED: 'open',
  SUSPENDED: 'open',
  DEADLOCKED: 'open',
  CLOSED: 'terminal',
  DECLINED: 'terminal',
  ABORTED: 'terminal',
  EXPIRED: 'terminal',
};

function enumOf<T extends string>(record: Record<T, unknown>): z.ZodEnum<[T, ...T[]]> {
  return z.enum(Object.keys(record) as [T, ...T[]]);
}

const hash = z.custom<Hash>((value) => isHash(value), { message: 'expected sha256:<64 hex>' });
const keyId = z.custom<KeyId>((value) => isKeyId(value), { message: 'expected ed25519:<64 hex>' });
const party = z.enum(['A', 'B']);
const decisionKind = z.enum(DECISION_KINDS as [DecisionKind, ...DecisionKind[]]);
const count = z.number().int().nonnegative();
const limit = z.number().int().positive();

const identitySchema: z.ZodType<Identity> = z
  .object({
    agent_key: keyId,
    human_key: keyId,
    human: z.string().min(1),
    org: z.string().optional(),
    repo: z.string().optional(),
    assurance: z.enum(['self_asserted', 'email_verified', 'domain_verified', 'org_attested']),
    x25519: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();

const budgetsSchema: z.ZodType<Budgets> = z
  .object({
    turns_per_party: limit,
    proposals: count,
    rounds_per_item: count,
    ttl_s: limit,
    max_msg_bytes: limit,
    max_plan_bytes: limit,
    no_progress_nudge: limit,
    no_progress_deadlock: limit,
    counter_streak_deadlock: limit,
  })
  .strict();

const charterSchema: z.ZodType<Charter> = z
  .object({
    session: z.string().min(1).max(128),
    topic: z.string(),
    type: z.enum(['contract', 'impact', 'plan', 'question', 'sync']),
    mode: z.enum(['org', 'open']),
    template: z.string(),
    inviter: identitySchema,
    invitee_label: z.string(),
    share_set: z.array(z.string()),
    budgets: budgetsSchema,
    checkpoint_kinds: z.array(decisionKind),
    created_at: z.string().datetime(),
    expires_at: z.string().datetime(),
  })
  .strict();

const proposeFields = {
  patch: z.array(z.unknown()),
  kinds: z.array(decisionKind),
  rationale: z.string(),
  checkpoint_ref: hash.optional(),
};
const reasons = z.array(z.object({ item: z.string().optional(), text: z.string() }).strict());

const statementSchema: z.ZodType<SignoffStatement> = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    session: z.string(),
    decision: z.enum(['approve', 'decline']),
    version: count,
    plan_hash: hash,
    md_hash: hash,
    mode: z.enum(['org', 'open']),
    charter_hash: hash,
    party,
    human: z.string(),
    human_key: keyId,
    ts: z.string().datetime(),
  })
  .strict();

const BODIES = {
  session_open: z.object({ charter: charterSchema, charter_hash: hash, plan_v0: z.unknown(), plan_v0_hash: hash }).strict(),
  hello: z.object({ charter_hash: hash, join_proof: z.string(), identity: identitySchema, resume: z.boolean().optional() }).strict(),
  welcome: z.object({ charter_hash: hash, identity: identitySchema }).strict(),
  say: z
    .object({ text: z.string(), evidence: z.array(z.object({ ref: z.string(), commit: z.string().optional() }).strict()).optional() })
    .strict(),
  propose: z.object(proposeFields).strict(),
  amend: z.object({ ...proposeFields, proposal: hash }).strict(),
  withdraw: z.object({ proposal: hash }).strict(),
  accept: z.object({ proposal: hash, result_hash: hash, checkpoint_ref: hash.optional() }).strict(),
  reject: z.object({ proposal: hash, reasons }).strict(),
  counter: z.object({ ...proposeFields, proposal: hash, reasons }).strict(),
  ask_user_pending: z
    .object({ checkpoint_id: z.string().min(1), reason: z.enum(['checkpoint', 'question']), kind: decisionKind.optional(), blocks: z.array(z.string()) })
    .strict(),
  user_answer_summary: z.object({ checkpoint_id: z.string().min(1), summary: z.string() }).strict(),
  request_signoff: z.object({ version: count, hash, md_hash: hash }).strict(),
  unfreeze: z.object({ reason: z.string() }).strict(),
  signoff: z.object({ statement: statementSchema, human_sig: z.string() }).strict(),
  plan_final: z.object({ plan_hash: hash, md_hash: hash, signoffs: z.array(hash) }).strict(),
  resolve: z.object({ action: z.enum(['extend', 'partial', 'abort']) }).strict(),
  heartbeat: z.object({ state: enumOf(SESSION_STATES), awaiting_human: z.boolean() }).strict(),
  error: z.object({ code: enumOf(ERROR_CODES), detail: z.string(), ref: hash.optional() }).strict(),
  abort: z.object({ reason: z.string() }).strict(),
  bye: z.object({ stored: hash }).strict(),
} satisfies Record<MessageType, z.ZodTypeAny>;

type Bodies = { [T in MessageType]: z.infer<(typeof BODIES)[T]> };

// ---------------------------------------------------------------- helpers

type Failure = { ok: false; code: ErrorCode; detail: string };
type Verdict = Failure | { ok: true; apply: () => void };

interface Ctx {
  r: ReplayResult;
  env: Envelope;
  opts: ReplayOptions;
  charter: Charter;
  party: Party;
  other: Party;
}

const UNVERIFIED: ReadonlySet<ErrorCode> = new Set(['BAD_SCHEMA', 'BAD_ID', 'BAD_SIGNATURE']);
const ACTIVE: ReadonlySet<SessionState> = new Set(['DISCUSSING', 'PROPOSAL_PENDING']);
const AFTER_WELCOME: ReadonlySet<SessionState> = new Set(['DISCUSSING', 'PROPOSAL_PENDING', 'FROZEN', 'AGREED', 'DEADLOCKED', 'SUSPENDED']);

function fail(code: ErrorCode, detail: string): Failure {
  return { ok: false, code, detail };
}

function accept(apply: () => void = () => {}): Verdict {
  return { ok: true, apply };
}

function isOpen(state: SessionState): boolean {
  return SESSION_STATES[state] === 'open';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

function joinProof(secret: Uint8Array, session: string): string {
  const tail = new TextEncoder().encode(session);
  const bytes = new Uint8Array(secret.length + tail.length);
  bytes.set(secret);
  bytes.set(tail, secret.length);
  return bytesToHex(sha256(bytes));
}

function hasCheckpointKind(charter: Charter, kinds: DecisionKind[]): boolean {
  return kinds.some((kind) => charter.checkpoint_kinds.includes(kind));
}

/** Log position of `ref` when it is a user_answer_summary from `party`, else -1. */
function answerPosition(r: ReplayResult, ref: Hash | undefined, party: Party): number {
  if (!ref) return -1;
  const answered = Object.values(r.checkpoints).some((c) => c.party === party && c.answeredIn === ref);
  return answered ? r.accepted.indexOf(ref) : -1;
}

function floorTurn(c: Ctx, progressed: boolean): void {
  const { r } = c;
  r.turns[c.party] += 1;
  r.floor = c.other;
  r.noProgress = progressed ? 0 : r.noProgress + 1;
  r.nudge = r.noProgress >= c.charter.budgets.no_progress_nudge;
}

function holdsFloor(c: Ctx): Failure | null {
  if (c.r.floor !== c.party) return fail('NOT_YOUR_FLOOR', `floor is ${c.r.floor ?? 'unassigned'}`);
  if (c.r.turns[c.party] >= c.r.turnBudget[c.party]) return fail('BUDGET_EXHAUSTED', `${c.party} has used its ${c.r.turnBudget[c.party]} turns`);
  return null;
}

function checkDeadlock(r: ReplayResult, budgets: Budgets): void {
  if (!ACTIVE.has(r.state)) return;
  const reason =
    r.turns.A >= r.turnBudget.A || r.turns.B >= r.turnBudget.B
      ? 'BUDGET_EXHAUSTED'
      : r.noProgress >= budgets.no_progress_deadlock
        ? 'NO_PROGRESS'
        : r.counterStreak >= budgets.counter_streak_deadlock
          ? 'COUNTER_STREAK'
          : null;
  if (reason) {
    r.state = 'DEADLOCKED';
    r.deadlockReason = reason;
  }
}

type ProposalBody = Bodies['propose'];

function checkpointReason(changedDecisions: string[], kinds: DecisionKind[]): string {
  return changedDecisions.length > 0 ? `changing decisions ${changedDecisions.join(', ')}` : `kinds ${kinds.join(', ')}`;
}

/** §2.5/§2.6 checks shared by propose, counter and amend, evaluated against the current plan. */
function checkProposal(
  c: Ctx,
  body: ProposalBody,
  type: PendingProposal['type'],
  alsoRejected?: Hash,
): Failure | { ok: true; pending: PendingProposal } {
  const { r, charter } = c;
  if (r.proposals >= charter.budgets.proposals) return fail('BUDGET_EXHAUSTED', `all ${charter.budgets.proposals} proposals used`);
  const applied = applyProposal(r.plan!, body.patch as JsonPatchOp[], c.party, charter.budgets);
  if (!applied.ok) return applied;
  if (r.rejectedHashes.includes(applied.hash) || applied.hash === alsoRejected) {
    return fail('RECREATES_REJECTED', `result ${applied.hash} was already rejected`);
  }
  const declared = new Set([...body.kinds, ...applied.effectiveKinds]);
  const kinds = DECISION_KINDS.filter((kind) => declared.has(kind));
  const checkpoint = applied.changedDecisions.length > 0 || hasCheckpointKind(charter, kinds);
  if (checkpoint && answerPosition(r, body.checkpoint_ref, c.party) < 0) {
    return fail('CHECKPOINT_SKIPPED', `${checkpointReason(applied.changedDecisions, kinds)} needs checkpoint_ref to an earlier user_answer_summary from ${c.party}`);
  }
  return {
    ok: true,
    pending: {
      id: c.env.id,
      from: c.party,
      type,
      patch: clone(body.patch) as JsonPatchOp[],
      kinds,
      checkpoint,
      resultHash: applied.hash,
      baseVersion: r.version,
    },
  };
}

function responseState(c: Ctx): Failure | null {
  if (!ACTIVE.has(c.r.state)) return fail('INVALID_STATE', `${c.env.type} not allowed in ${c.r.state}`);
  return null;
}

/** The pending proposal named by `id`, for messages only its proposer may send. */
function ownPending(c: Ctx, id: Hash): Failure | { ok: true; pending: PendingProposal } {
  const pending = c.r.pending;
  if (!pending || pending.id !== id) return fail('NO_SUCH_PROPOSAL', `${id} is not the pending proposal`);
  if (pending.from !== c.party) return fail('INVALID_STATE', `only ${pending.from} may ${c.env.type} its proposal`);
  return { ok: true, pending };
}

// ---------------------------------------------------------------- rules

type Rule = (c: Ctx, body: never) => Verdict;
const RULES: { [T in MessageType]: (c: Ctx, body: Bodies[T]) => Verdict } = {
  session_open: () => fail('INVALID_STATE', 'session is already open'),

  hello: (c, body) => {
    const { r } = c;
    if (c.party !== 'B' || r.state !== 'INVITED') return fail('INVALID_STATE', `hello from ${c.party} in ${r.state}`);
    if (body.charter_hash !== r.charterHash) return fail('CHARTER_MISMATCH', 'hello names a different charter');
    if (body.identity.agent_key !== c.env.from.agent_key) return fail('UNKNOWN_SENDER', 'identity.agent_key differs from the sender');
    if (c.opts.joinSecret && body.join_proof !== joinProof(c.opts.joinSecret, c.charter.session)) {
      return fail('JOIN_PROOF_INVALID', 'join_proof does not match the join secret');
    }
    return accept(() => {
      r.identities.B = clone(body.identity);
      r.state = 'HANDSHAKE';
    });
  },

  welcome: (c, body) => {
    const { r } = c;
    if (c.party !== 'A' || r.state !== 'HANDSHAKE') return fail('INVALID_STATE', `welcome from ${c.party} in ${r.state}`);
    if (body.charter_hash !== r.charterHash) return fail('CHARTER_MISMATCH', 'welcome names a different charter');
    if (body.identity.agent_key !== c.env.from.agent_key) return fail('UNKNOWN_SENDER', 'identity.agent_key differs from the sender');
    const ts = Date.parse(c.env.ts);
    if (!(ts >= Date.parse(c.charter.created_at) && ts <= Date.parse(c.charter.expires_at))) {
      return fail('INVALID_STATE', `welcome ts ${c.env.ts} is outside the charter's ${c.charter.created_at} to ${c.charter.expires_at}`);
    }
    return accept(() => {
      r.state = 'DISCUSSING';
      r.floor = 'A';
      r.welcomedAt = c.env.ts;
    });
  },

  say: (c) => {
    if (!ACTIVE.has(c.r.state) && c.r.state !== 'FROZEN') return fail('INVALID_STATE', `say not allowed in ${c.r.state}`);
    const floor = holdsFloor(c);
    if (floor) return floor;
    return accept(() => floorTurn(c, false));
  },

  propose: (c, body) => {
    const { r } = c;
    if (r.state === 'PROPOSAL_PENDING') return fail('PROPOSAL_PENDING', `${r.pending?.id} is pending`);
    if (r.state !== 'DISCUSSING') return fail('INVALID_STATE', `propose not allowed in ${r.state}`);
    if (r.signoffRequest) return fail('INVALID_STATE', 'a signoff request is pending');
    const floor = holdsFloor(c);
    if (floor) return floor;
    const checked = checkProposal(c, body, 'propose');
    if (!checked.ok) return checked;
    return accept(() => {
      r.pending = checked.pending;
      r.proposals += 1;
      r.state = 'PROPOSAL_PENDING';
      floorTurn(c, false);
    });
  },

  counter: (c, body) => {
    const { r } = c;
    const state = responseState(c);
    if (state) return state;
    const floor = holdsFloor(c);
    if (floor) return floor;
    if (r.signoffRequest?.id === body.proposal) return fail('INVALID_STATE', 'a signoff request cannot be countered');
    const pending = r.pending;
    if (!pending || pending.id !== body.proposal) return fail('NO_SUCH_PROPOSAL', `${body.proposal} is not the pending proposal`);
    if (pending.from === c.party) return fail('INVALID_STATE', 'cannot counter your own proposal');
    const checked = checkProposal(c, body, 'counter', pending.resultHash);
    if (!checked.ok) return checked;
    return accept(() => {
      r.rejectedHashes.push(pending.resultHash);
      r.pending = checked.pending;
      r.proposals += 1;
      r.counterStreak += 1;
      floorTurn(c, false);
    });
  },

  amend: (c, body) => {
    const { r } = c;
    const state = responseState(c);
    if (state) return state;
    const own = ownPending(c, body.proposal);
    if (!own.ok) return own;
    const checked = checkProposal(c, body, 'amend');
    if (!checked.ok) return checked;
    return accept(() => {
      r.pending = checked.pending;
      r.proposals += 1;
    });
  },

  withdraw: (c, body) => {
    const { r } = c;
    const state = responseState(c);
    if (state) return state;
    const own = ownPending(c, body.proposal);
    if (!own.ok) return own;
    return accept(() => {
      r.pending = null;
      r.state = 'DISCUSSING';
      r.counterStreak = 0;
    });
  },

  accept: (c, body) => {
    const { r, charter } = c;
    const state = responseState(c);
    if (state) return state;
    const pending = r.pending;
    if (pending && pending.id === body.proposal) {
      const floor = holdsFloor(c);
      if (floor) return floor;
      if (pending.from === c.party) return fail('INVALID_STATE', 'cannot accept your own proposal');
      if (body.result_hash !== pending.resultHash) return fail('STALE_BASE', `result is ${pending.resultHash}`);
      if (pending.checkpoint && answerPosition(r, body.checkpoint_ref, c.party) <= r.accepted.indexOf(pending.id)) {
        return fail('CHECKPOINT_SKIPPED', `accepting this proposal needs checkpoint_ref to a user_answer_summary from ${c.party} after the proposal`);
      }
      const applied = applyProposal(r.plan!, pending.patch, pending.from, charter.budgets);
      if (!applied.ok || applied.hash !== pending.resultHash) return fail('STALE_BASE', 'proposal no longer applies');
      return accept(() => {
        r.plan = applied.plan;
        r.planHash = applied.hash;
        r.version = applied.plan.version;
        r.pending = null;
        r.state = 'DISCUSSING';
        r.counterStreak = 0;
        floorTurn(c, true);
      });
    }
    const request = r.signoffRequest;
    if (request && request.id === body.proposal) {
      if (request.from === c.party) return fail('INVALID_STATE', 'cannot accept your own signoff request');
      if (body.result_hash !== request.hash) return fail('STALE_BASE', `signoff request is for ${request.hash}`);
      return accept(() => {
        r.frozen = { version: request.version, hash: request.hash, mdHash: request.mdHash };
        r.signoffRequest = null;
        r.signoffs = {};
        r.state = 'FROZEN';
      });
    }
    return fail('NO_SUCH_PROPOSAL', `${body.proposal} is neither the pending proposal nor a signoff request`);
  },

  reject: (c, body) => {
    const { r } = c;
    const state = responseState(c);
    if (state) return state;
    const pending = r.pending;
    if (pending && pending.id === body.proposal) {
      const floor = holdsFloor(c);
      if (floor) return floor;
      if (pending.from === c.party) return fail('INVALID_STATE', 'cannot reject your own proposal');
      return accept(() => {
        r.rejectedHashes.push(pending.resultHash);
        r.pending = null;
        r.state = 'DISCUSSING';
        r.counterStreak = 0;
        floorTurn(c, false);
      });
    }
    const request = r.signoffRequest;
    if (request && request.id === body.proposal) {
      if (request.from === c.party) return fail('INVALID_STATE', 'cannot reject your own signoff request');
      return accept(() => {
        r.signoffRequest = null;
      });
    }
    return fail('NO_SUCH_PROPOSAL', `${body.proposal} is neither the pending proposal nor a signoff request`);
  },

  ask_user_pending: (c, body) => {
    const { r } = c;
    if (!AFTER_WELCOME.has(r.state)) return fail('INVALID_STATE', `ask_user_pending not allowed in ${r.state}`);
    if (getOwn(r.checkpoints, body.checkpoint_id)) return fail('INVALID_STATE', `checkpoint ${body.checkpoint_id} already exists`);
    return accept(() => {
      setOwn(r.checkpoints, body.checkpoint_id, { party: c.party, askedIn: c.env.id, answeredIn: null });
      r.awaitingHuman[c.party] = true;
    });
  },

  user_answer_summary: (c, body) => {
    const { r } = c;
    if (!AFTER_WELCOME.has(r.state)) return fail('INVALID_STATE', `user_answer_summary not allowed in ${r.state}`);
    const checkpoint = getOwn(r.checkpoints, body.checkpoint_id);
    if (!checkpoint || checkpoint.party !== c.party) return fail('INVALID_STATE', `${c.party} has no checkpoint ${body.checkpoint_id}`);
    if (checkpoint.answeredIn) return fail('INVALID_STATE', `checkpoint ${body.checkpoint_id} is already answered`);
    return accept(() => {
      checkpoint.answeredIn = c.env.id;
      r.awaitingHuman[c.party] = Object.values(r.checkpoints).some((cp) => cp.party === c.party && cp.answeredIn === null);
    });
  },

  request_signoff: (c, body) => {
    const { r } = c;
    if (r.state !== 'DISCUSSING') return fail('INVALID_STATE', `request_signoff not allowed in ${r.state}`);
    if (r.signoffRequest) return fail('INVALID_STATE', 'a signoff request is already pending');
    const plan = r.plan!;
    if (body.version !== r.version || body.hash !== r.planHash) return fail('INVALID_STATE', `plan is at version ${r.version} ${r.planHash}`);
    const mdHash = markdownHash(plan);
    if (body.md_hash !== mdHash) return fail('INVALID_STATE', `md_hash is ${mdHash}`);
    const blocking = plan.open_items.find((item) => item.blocking && item.status === 'open');
    if (blocking) return fail('INVALID_STATE', `open item ${blocking.id} is blocking`);
    return accept(() => {
      r.signoffRequest = { id: c.env.id, from: c.party, version: body.version, hash: body.hash, mdHash };
    });
  },

  unfreeze: (c) => {
    const { r } = c;
    if (r.state !== 'FROZEN') return fail('INVALID_STATE', `unfreeze not allowed in ${r.state}`);
    if (Object.keys(r.signoffs).length > 0) return fail('INVALID_STATE', 'a signoff has already been collected');
    return accept(() => {
      r.state = 'DISCUSSING';
      r.frozen = null;
    });
  },

  signoff: (c, body) => {
    const { r, charter } = c;
    if (r.state !== 'FROZEN') return fail('INVALID_STATE', `signoff not allowed in ${r.state}`);
    if (r.signoffs[c.party]) return fail('INVALID_STATE', `${c.party} has already signed`);
    const s = body.statement;
    const frozen = r.frozen!;
    const checks: [string, boolean][] = [
      ['session', s.session === charter.session],
      ['version', s.version === frozen.version],
      ['plan_hash', s.plan_hash === frozen.hash],
      ['md_hash', s.md_hash === frozen.mdHash],
      ['mode', s.mode === charter.mode],
      ['charter_hash', s.charter_hash === r.charterHash],
      ['party', s.party === c.party],
      ['human', s.human === r.identities[c.party]?.human],
      ['human_key', s.human_key === r.identities[c.party]?.human_key],
    ];
    const wrong = checks.find(([, ok]) => !ok);
    if (wrong) return fail('SIGNOFF_MISMATCH', `statement ${wrong[0]} does not match the frozen plan`);
    if (!verifyObject(s, body.human_sig, s.human_key)) return fail('SIGNOFF_MISMATCH', 'human_sig does not verify');
    return accept(() => {
      if (s.decision === 'decline') {
        r.state = 'DISCUSSING';
        r.frozen = null;
        r.signoffs = {};
        return;
      }
      r.signoffs[c.party] = { id: c.env.id, statement: clone(s), human_sig: body.human_sig };
      if (r.signoffs.A && r.signoffs.B) r.state = 'AGREED';
    });
  },

  plan_final: (c, body) => {
    const { r } = c;
    if (r.state !== 'AGREED' || r.final) return fail('INVALID_STATE', r.final ? 'plan_final already sent' : `plan_final not allowed in ${r.state}`);
    const frozen = r.frozen!;
    if (body.plan_hash !== frozen.hash || body.md_hash !== frozen.mdHash) return fail('SIGNOFF_MISMATCH', 'hashes differ from the agreed plan');
    const ids = [r.signoffs.A!.id, r.signoffs.B!.id];
    if (body.signoffs.length !== 2 || !ids.every((id) => body.signoffs.includes(id))) {
      return fail('SIGNOFF_MISMATCH', 'signoffs must list the approve signoff of each party');
    }
    return accept(() => {
      r.final = { id: c.env.id, planHash: frozen.hash };
    });
  },

  resolve: (c, body) => {
    const { r, charter } = c;
    if (r.state !== 'DEADLOCKED') return fail('INVALID_STATE', `resolve not allowed in ${r.state}`);
    if (body.action === 'partial') return fail('INVALID_STATE', 'partial resolution is not supported in cma/0.1');
    if (body.action === 'abort') {
      return accept(() => {
        r.state = 'ABORTED';
      });
    }
    const extension = Math.ceil(charter.budgets.turns_per_party / 2);
    return accept(() => {
      r.state = 'DISCUSSING';
      r.pending = null;
      r.signoffRequest = null;
      r.noProgress = 0;
      r.nudge = false;
      r.counterStreak = 0;
      r.deadlockReason = null;
      r.turnBudget = { A: r.turnBudget.A + extension, B: r.turnBudget.B + extension };
    });
  },

  heartbeat: (c) => (isOpen(c.r.state) ? accept() : fail('INVALID_STATE', `session is ${c.r.state}`)),

  error: (c) => (isOpen(c.r.state) ? accept() : fail('INVALID_STATE', `session is ${c.r.state}`)),

  abort: (c) => {
    const { r } = c;
    if (!isOpen(r.state)) return fail('INVALID_STATE', `session is ${r.state}`);
    return accept(() => {
      r.state = c.party === 'B' && r.state === 'INVITED' ? 'DECLINED' : 'ABORTED';
    });
  },

  bye: (c, body) => {
    const { r } = c;
    if (r.state !== 'AGREED' || !r.final) return fail('INVALID_STATE', r.state === 'AGREED' ? 'bye before plan_final' : `bye not allowed in ${r.state}`);
    if (r.stored[c.party]) return fail('INVALID_STATE', `${c.party} already said bye`);
    if (body.stored !== r.final.planHash) return fail('INVALID_STATE', `stored hash differs from the agreed ${r.final.planHash}`);
    return accept(() => {
      r.stored[c.party] = body.stored;
      if (r.stored.A && r.stored.B) r.state = 'CLOSED';
    });
  },
};

// ---------------------------------------------------------------- replay

function parseBody<T extends MessageType>(type: T, body: unknown): Failure | { ok: true; body: Bodies[T] } {
  const parsed = BODIES[type].safeParse(body);
  if (parsed.success) return { ok: true, body: parsed.data as Bodies[T] };
  const issue = parsed.error.issues[0];
  return fail('BAD_SCHEMA', `${type} body: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'}`);
}

function initialResult(): ReplayResult {
  return {
    state: 'INVITED',
    charter: null,
    charterHash: null,
    identities: {},
    plan: null,
    planHash: null,
    version: 0,
    pending: null,
    signoffRequest: null,
    frozen: null,
    signoffs: {},
    final: null,
    stored: {},
    floor: null,
    turns: { A: 0, B: 0 },
    turnBudget: { A: 0, B: 0 },
    proposals: 0,
    noProgress: 0,
    nudge: false,
    counterStreak: 0,
    deadlockReason: null,
    awaitingHuman: { A: false, B: false },
    checkpoints: {},
    rejectedHashes: [],
    accepted: [],
    rejected: [],
    lastSeq: { A: 0, B: 0 },
    lastId: { A: null, B: null },
    welcomedAt: null,
  };
}

function genesis(r: ReplayResult, env: Envelope): Verdict {
  if (env.type !== 'session_open') return fail('INVALID_STATE', 'the first message must be session_open');
  if (env.from.party !== 'A') return fail('UNKNOWN_SENDER', 'session_open must come from A');
  const chain = new ChainTracker({ seq: r.lastSeq, id: r.lastId }).check(env);
  if (!chain.ok) return chain;
  const parsed = parseBody('session_open', env.body);
  if (!parsed.ok) return parsed;
  const { charter, charter_hash, plan_v0, plan_v0_hash } = parsed.body;
  if (env.from.agent_key !== charter.inviter.agent_key) return fail('UNKNOWN_SENDER', 'session_open is not signed by charter.inviter');
  if (env.session !== charter.session) return fail('CHARTER_MISMATCH', 'envelope session differs from charter.session');
  if (charter_hash !== hashObject(charter)) return fail('CHARTER_MISMATCH', 'charter_hash does not match the charter');
  const checked = checkPlan(plan_v0, charter.budgets.max_plan_bytes);
  if (!checked.ok) return fail(checked.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'BAD_SCHEMA', `plan_v0: ${checked.detail}`);
  const plan = checked.plan;
  if (canonicalString(plan) !== canonicalString(createPlanV0(charter, charter_hash, charter.invitee_label))) {
    return fail('CHARTER_MISMATCH', 'plan_v0 is not the template plan of this charter');
  }
  if (plan_v0_hash !== planHash(plan)) return fail('CHARTER_MISMATCH', 'plan_v0_hash does not match plan_v0');
  return accept(() => {
    r.charter = clone(charter);
    r.charterHash = charter_hash;
    r.identities = { A: clone(charter.inviter) };
    r.plan = clone(plan);
    r.planHash = plan_v0_hash;
    r.version = 0;
    r.turnBudget = { A: charter.budgets.turns_per_party, B: charter.budgets.turns_per_party };
    r.state = 'INVITED';
  });
}

function membership(r: ReplayResult, env: Envelope): Failure | null {
  const known = r.identities[env.from.party];
  if (known) return known.agent_key === env.from.agent_key ? null : fail('UNKNOWN_SENDER', `${env.from.agent_key} is not ${env.from.party}`);
  // B is defined by its first valid hello; before that an invitee may only say hello or decline.
  if (env.type === 'hello' || (env.type === 'abort' && r.state === 'INVITED')) return null;
  return fail('UNKNOWN_SENDER', `${env.from.party} has not joined`);
}

function evaluate(r: ReplayResult, charter: Charter, env: Envelope, opts: ReplayOptions): Verdict {
  if (env.session !== charter.session) return fail('CHARTER_MISMATCH', `message is for session ${env.session}`);
  const member = membership(r, env);
  if (member) return member;
  const chain = new ChainTracker({ seq: r.lastSeq, id: r.lastId }).check(env);
  if (!chain.ok) return chain;
  const parsed = parseBody(env.type, env.body);
  if (!parsed.ok) return parsed;
  const party = env.from.party;
  const ctx: Ctx = { r, env, opts, charter, party, other: party === 'A' ? 'B' : 'A' };
  return (RULES[env.type] as Rule)(ctx, parsed.body as never);
}

type Outcome = { kind: 'accepted' } | { kind: 'ignored' } | { kind: 'rejected'; code: ErrorCode; detail: string };

export const MAX_ENVELOPE_DEPTH = 64;
export const MAX_ENVELOPE_NODES = 20_000;

/** Iterative walk that rejects values nested deeper than MAX_ENVELOPE_DEPTH or with more than MAX_ENVELOPE_NODES values. */
function exceedsBounds(raw: unknown): string | null {
  const stack: { value: unknown; depth: number }[] = [{ value: raw, depth: 1 }];
  let nodes = 1;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (typeof value !== 'object' || value === null) continue;
    if (depth > MAX_ENVELOPE_DEPTH) return `envelope nests deeper than ${MAX_ENVELOPE_DEPTH} levels`;
    const children = Array.isArray(value) ? value : Object.values(value);
    nodes += children.length;
    if (nodes > MAX_ENVELOPE_NODES) return `envelope has more than ${MAX_ENVELOPE_NODES} values`;
    for (const child of children) stack.push({ value: child, depth: depth + 1 });
  }
  return null;
}

/** The id to record a rejection under: the claimed id when it looks like one, else a hash of the entry when that is safe to compute. */
function claimedId(raw: unknown, hashable: boolean): Hash {
  try {
    const id = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
    if (isHash(id)) return id;
    if (hashable) return hashObject(raw);
  } catch {
    // unreadable entry
  }
  return sha256Hash(`unidentifiable ${typeof raw}`);
}

function seen(r: ReplayResult, id: Hash): boolean {
  return r.accepted.includes(id) || r.rejected.some((x) => x.id === id && !UNVERIFIED.has(x.code));
}

function reject(r: ReplayResult, id: Hash, code: ErrorCode, detail: string): Outcome {
  r.rejected.push({ id, code, detail });
  return { kind: 'rejected', code, detail };
}

/** Applies one log entry to `r` in place. */
function step(r: ReplayResult, raw: unknown, opts: ReplayOptions): Outcome {
  const unbounded = exceedsBounds(raw);
  if (unbounded) return reject(r, claimedId(raw, false), 'BAD_SCHEMA', unbounded);
  const verified = verifyEnvelope(raw);
  if (!verified.ok) return reject(r, claimedId(raw, true), verified.code, verified.detail);
  const env = verified.envelope;
  if (seen(r, env.id)) return { kind: 'ignored' };
  const verdict = r.charter === null ? genesis(r, env) : evaluate(r, r.charter, env, opts);
  if (!verdict.ok) return reject(r, env.id, verdict.code, verdict.detail);
  r.lastSeq[env.from.party] = env.seq;
  r.lastId[env.from.party] = env.id;
  r.accepted.push(env.id);
  verdict.apply();
  checkDeadlock(r, r.charter!.budgets);
  return { kind: 'accepted' };
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unprintable error';
  }
}

/** `step`, with any exception recorded as a BAD_SCHEMA rejection instead of escaping. */
function safeStep(r: ReplayResult, raw: unknown, opts: ReplayOptions): Outcome {
  try {
    return step(r, raw, opts);
  } catch (error) {
    return reject(r, claimedId(raw, false), 'BAD_SCHEMA', `exception: ${errorMessage(error)}`);
  }
}

function applyClock(r: ReplayResult, now: string | undefined): void {
  if (now === undefined || r.charter === null) return;
  const at = Date.parse(now);
  if (Number.isNaN(at)) throw new RangeError(`opts.now is not an ISO-8601 time: ${now}`);
  if (r.state === 'INVITED' || r.state === 'HANDSHAKE') {
    if (at > Date.parse(r.charter.expires_at)) r.state = 'EXPIRED';
  } else if (isOpen(r.state) && r.welcomedAt !== null && at > Date.parse(r.welcomedAt) + r.charter.budgets.ttl_s * 1000) {
    r.state = 'EXPIRED';
  }
}

/** Relay order when every entry carries a relay_seq (stable for ties), otherwise the given order. */
function relayOrder(log: Envelope[]): Envelope[] {
  const seqs = log.map((entry) => {
    try {
      return (entry as { relay_seq?: unknown } | null)?.relay_seq;
    } catch {
      return undefined;
    }
  });
  if (!seqs.every((seq) => typeof seq === 'number')) return [...log];
  return log
    .map((entry, index) => ({ entry, seq: seqs[index] as number }))
    .sort((a, b) => a.seq - b.seq)
    .map(({ entry }) => entry);
}

/** Folds a session log into its state (§2.2). Invalid messages are recorded in `rejected`, never thrown. */
export function replay(log: Envelope[], opts: ReplayOptions = {}): ReplayResult {
  const r = initialResult();
  for (const entry of relayOrder(log)) safeStep(r, entry, opts);
  applyClock(r, opts.now);
  return r;
}

/** Whether `env` would be accepted if it were the next message after `result`. */
export function validateNext(
  result: ReplayResult,
  env: Envelope,
  opts: ReplayOptions = {},
): { ok: true } | { ok: false; code: ErrorCode; detail: string } {
  const r = clone(result);
  applyClock(r, opts.now);
  const outcome = safeStep(r, env, opts);
  if (outcome.kind === 'accepted') return { ok: true };
  if (outcome.kind === 'ignored') return { ok: false, code: 'CHAIN_DUPLICATE', detail: `${env.id} is already in the log` };
  return { ok: false, code: outcome.code, detail: outcome.detail };
}
