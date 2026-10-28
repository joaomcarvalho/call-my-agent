// CMA/0.1 wire and plan types. This file is the contract between packages:
// changing a type here is a protocol change and needs the orchestrator's sign-off.

export const PROTOCOL_VERSION = 'cma/0.1' as const;
export const PLAN_SCHEMA = 'cma-plan/1' as const;

export type Party = 'A' | 'B';
export const PARTIES: readonly Party[] = ['A', 'B'];

/** `sha256:` + 64 lowercase hex chars. */
export type Hash = `sha256:${string}`;
/** `ed25519:` + 64 lowercase hex chars of the raw 32-byte public key. */
export type KeyId = `ed25519:${string}`;

export type Mode = 'org' | 'open';
export type CallType = 'contract' | 'impact' | 'plan' | 'question';

export type DecisionKind =
  | 'breaking_change'
  | 'security_or_pii'
  | 'data_retention'
  | 'cost_or_quota'
  | 'deadline_commitment'
  | 'scope_change'
  | 'ownership_change';

export const DECISION_KINDS: readonly DecisionKind[] = [
  'breaking_change',
  'security_or_pii',
  'data_retention',
  'cost_or_quota',
  'deadline_commitment',
  'scope_change',
  'ownership_change',
];

export type MessageType =
  | 'session_open'
  | 'hello'
  | 'welcome'
  | 'say'
  | 'propose'
  | 'amend'
  | 'withdraw'
  | 'accept'
  | 'reject'
  | 'counter'
  | 'ask_user_pending'
  | 'user_answer_summary'
  | 'request_signoff'
  | 'unfreeze'
  | 'signoff'
  | 'plan_final'
  | 'resolve'
  | 'heartbeat'
  | 'error'
  | 'abort'
  | 'bye';

export type ErrorCode =
  | 'BAD_SCHEMA'
  | 'BAD_SIGNATURE'
  | 'BAD_ID'
  | 'UNKNOWN_SENDER'
  | 'CHAIN_GAP'
  | 'CHAIN_DUPLICATE'
  | 'CHAIN_FORK'
  | 'NOT_YOUR_FLOOR'
  | 'PROPOSAL_PENDING'
  | 'NO_SUCH_PROPOSAL'
  | 'STALE_BASE'
  | 'BAD_PATCH'
  | 'OWNER_VIOLATION'
  | 'BUDGET_EXHAUSTED'
  | 'INVALID_STATE'
  | 'CHARTER_MISMATCH'
  | 'JOIN_PROOF_INVALID'
  | 'IDENTITY_INSUFFICIENT'
  | 'MODE_VIOLATION'
  | 'CHECKPOINT_SKIPPED'
  | 'RECREATES_REJECTED'
  | 'SIGNOFF_MISMATCH'
  | 'TOO_LARGE';

export interface Sender {
  party: Party;
  agent_key: KeyId;
  /** Human-readable handle of the human this agent represents (email or name). */
  human: string;
  org?: string;
}

export interface PlanRef {
  version: number;
  hash: Hash;
}

export interface Meter {
  turn: number;
  turn_budget: number;
  proposals: number;
}

/** Everything that is signed. `id`, `sig` and `relay_seq` are excluded from the signing bytes. */
export interface UnsignedEnvelope<B = Record<string, unknown>> {
  v: typeof PROTOCOL_VERSION;
  session: string;
  from: Sender;
  to: Party[];
  /** Per-sender sequence, starting at 1. */
  seq: number;
  /** `id` of this sender's previous message, null for seq 1. */
  prev: Hash | null;
  /** Highest seq seen per party (vector clock). */
  ack: Partial<Record<Party, number>>;
  /** ISO-8601 UTC. */
  ts: string;
  type: MessageType;
  reply_to?: Hash;
  floor?: 'hold' | 'yield';
  plan_ref?: PlanRef;
  meter?: Meter;
  body: B;
}

export interface Signature {
  alg: 'Ed25519';
  kid: KeyId;
  /** base64url (no padding) of the 64-byte signature. */
  value: string;
}

export interface Envelope<B = Record<string, unknown>> extends UnsignedEnvelope<B> {
  /** sha256 of the signing bytes. */
  id: Hash;
  sig: Signature;
  /** Stamped by the relay, unsigned. Orders glare only. */
  relay_seq?: number;
}

// ---------------------------------------------------------------- charter

export interface Budgets {
  turns_per_party: number;
  proposals: number;
  rounds_per_item: number;
  ttl_s: number;
  max_msg_bytes: number;
  max_plan_bytes: number;
  /** Floor turns without a version change before a "converge or defer" nudge. */
  no_progress_nudge: number;
  /** Floor turns without a version change before DEADLOCKED. */
  no_progress_deadlock: number;
  /** Consecutive counters on one proposal chain before DEADLOCKED. */
  counter_streak_deadlock: number;
}

export const DEFAULT_BUDGETS: Record<Mode, Budgets> = {
  org: {
    turns_per_party: 60,
    proposals: 20,
    rounds_per_item: 4,
    ttl_s: 7200,
    max_msg_bytes: 16384,
    max_plan_bytes: 65536,
    no_progress_nudge: 6,
    no_progress_deadlock: 10,
    counter_streak_deadlock: 3,
  },
  open: {
    turns_per_party: 30,
    proposals: 20,
    rounds_per_item: 4,
    ttl_s: 3600,
    max_msg_bytes: 16384,
    max_plan_bytes: 65536,
    no_progress_nudge: 6,
    no_progress_deadlock: 10,
    counter_streak_deadlock: 3,
  },
};

export interface Identity {
  agent_key: KeyId;
  /** Key the human signs the final plan with. Never available to the model. */
  human_key: KeyId;
  human: string;
  org?: string;
  repo?: string;
  assurance: 'self_asserted' | 'email_verified' | 'domain_verified' | 'org_attested';
  /** X25519 public key for end-to-end encryption, hex. */
  x25519?: string;
}

export interface Charter {
  session: string;
  topic: string;
  type: CallType;
  mode: Mode;
  template: string;
  /** Inviter identity. The invitee's identity arrives in `hello`. */
  inviter: Identity;
  /** Free-form label for who is being called, e.g. "bob" or "billing team". */
  invitee_label: string;
  share_set: string[];
  budgets: Budgets;
  /** Decision kinds that require a checkpoint_ref before propose/accept. Applies to both parties. */
  checkpoint_kinds: DecisionKind[];
  created_at: string;
  expires_at: string;
}

// ---------------------------------------------------------------- plan

export type SectionType =
  | 'prose'
  | 'interface'
  | 'data_schema'
  | 'migration'
  | 'rollout'
  | 'ownership'
  | 'risks'
  | 'checklist'
  | `custom:${string}`;

export type SectionOwner = Party | 'joint';

export interface Artifact {
  name: string;
  /** e.g. openapi-3.1, protobuf, graphql-sdl, json-schema, sql-ddl */
  format: string;
  content: string;
  /** sha256 of the UTF-8 content. Must match. */
  sha256: Hash;
}

export interface PlanSection {
  id: string;
  title: string;
  type: SectionType;
  owner: SectionOwner;
  md: string;
  artifacts?: Artifact[];
}

export type DecidedBy = 'human-A' | 'human-B' | 'agent-assumed';

export interface Decision {
  id: string;
  text: string;
  kind?: DecisionKind;
  decided_by: DecidedBy;
  /** id of the accept message that settled it. Filled when known, else null. */
  decided_in: Hash | null;
}

export interface Disagreement {
  id: string;
  text: string;
  resolution: string;
}

export interface OpenItem {
  id: string;
  text: string;
  blocking: boolean;
  owner: SectionOwner;
  status: 'open' | 'resolved' | 'deferred';
}

export interface ActionItem {
  id: string;
  text: string;
}

export interface Plan {
  schema: typeof PLAN_SCHEMA;
  session: string;
  version: number;
  /** plan_hash of the previous version, null for v0. */
  parent: Hash | null;
  meta: {
    title: string;
    type: CallType;
    parties: Record<Party, string>;
    charter_hash: Hash;
  };
  sections: PlanSection[];
  decisions: Decision[];
  disagreements: Disagreement[];
  open_items: OpenItem[];
  action_items: Record<Party, ActionItem[]>;
}

export interface JsonPatchOp {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

// ---------------------------------------------------------------- bodies

export interface Evidence {
  /** `path:line` or `path:start-end`, relative to the sender's repo. */
  ref: string;
  /** Commit SHA the ref was read at, when known. */
  commit?: string;
}

export interface SessionOpenBody {
  charter: Charter;
  charter_hash: Hash;
  plan_v0: Plan;
  plan_v0_hash: Hash;
}

export interface HelloBody {
  charter_hash: Hash;
  /** hex sha256(join_secret_bytes || utf8(session)) */
  join_proof: string;
  identity: Identity;
  resume?: boolean;
}

export interface WelcomeBody {
  charter_hash: Hash;
  identity: Identity;
}

export interface SayBody {
  text: string;
  evidence?: Evidence[];
}

export interface ProposeBody {
  patch: JsonPatchOp[];
  kinds: DecisionKind[];
  rationale: string;
  /** id of this sender's own user_answer_summary that cleared a checkpoint. */
  checkpoint_ref?: Hash;
}

export interface AmendBody extends ProposeBody {
  proposal: Hash;
}

export interface WithdrawBody {
  proposal: Hash;
}

export interface AcceptBody {
  /** id of the propose/counter/amend or request_signoff being accepted. */
  proposal: Hash;
  /** Resulting plan hash, so both sides can check they computed the same thing. */
  result_hash: Hash;
  checkpoint_ref?: Hash;
}

export interface RejectReason {
  item?: string;
  text: string;
}

export interface RejectBody {
  proposal: Hash;
  reasons: RejectReason[];
}

export interface CounterBody extends ProposeBody {
  proposal: Hash;
  reasons: RejectReason[];
}

export interface AskUserPendingBody {
  checkpoint_id: string;
  reason: 'checkpoint' | 'question';
  kind?: DecisionKind;
  /** Plan item ids (sections, decisions, open items) this question blocks. */
  blocks: string[];
}

export interface UserAnswerSummaryBody {
  checkpoint_id: string;
  summary: string;
}

export interface RequestSignoffBody {
  version: number;
  hash: Hash;
  md_hash: Hash;
}

export interface UnfreezeBody {
  reason: string;
}

/** What a human signs. Canonicalized with JCS, signed with the human key. */
export interface SignoffStatement {
  v: typeof PROTOCOL_VERSION;
  session: string;
  decision: 'approve' | 'decline';
  version: number;
  plan_hash: Hash;
  md_hash: Hash;
  mode: Mode;
  charter_hash: Hash;
  party: Party;
  human: string;
  human_key: KeyId;
  ts: string;
}

export interface SignoffBody {
  statement: SignoffStatement;
  /** base64url Ed25519 signature by statement.human_key over JCS(statement). */
  human_sig: string;
}

export interface PlanFinalBody {
  plan_hash: Hash;
  md_hash: Hash;
  /** ids of the signoff messages, one per party. */
  signoffs: Hash[];
}

export interface ResolveBody {
  action: 'extend' | 'partial' | 'abort';
}

export interface HeartbeatBody {
  state: SessionState;
  awaiting_human: boolean;
}

export interface ErrorBody {
  code: ErrorCode;
  detail: string;
  ref?: Hash;
}

export interface AbortBody {
  reason: string;
}

export interface ByeBody {
  stored: Hash;
}

// ---------------------------------------------------------------- state

export type SessionState =
  | 'INVITED'
  | 'HANDSHAKE'
  | 'DISCUSSING'
  | 'PROPOSAL_PENDING'
  | 'FROZEN'
  | 'AGREED'
  | 'CLOSED'
  | 'SUSPENDED'
  | 'DEADLOCKED'
  | 'DECLINED'
  | 'ABORTED'
  | 'EXPIRED';
