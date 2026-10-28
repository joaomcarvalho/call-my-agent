# T2 · Protocol core: chain, plan, renderer, state machine

**Owns:** `packages/protocol/src/{chain,plan,render,state,templates}.ts`, `packages/protocol/test/{chain,plan,render,state,transcript}.test.ts`, `packages/protocol/test/fixtures/**`. Do not edit `index.ts`; import from your own files in tests. The orchestrator adds the exports on merge.

**Spec:** implementation-spec §2.2–§2.8. This is the heart of the protocol: be exact. Pure functions only, no I/O, no `Date.now()` (time comes in via `opts.now`).

## API to implement

```ts
// plan.ts
export const PlanSchema: z.ZodType<Plan>                         // strict; validates every field in types.ts
export function planHash(plan: Plan): Hash                      // hashObject(plan)
export type ApplyResult = { ok: true; plan: Plan; hash: Hash; effectiveKinds: DecisionKind[] } | { ok: false; code: ErrorCode; detail: string }
export function applyProposal(plan: Plan, patch: JsonPatchOp[], by: Party, budgets: Budgets): ApplyResult   // §2.5 rules + §2.6 kinds (declared kinds are merged by the caller)

// templates.ts
export function createPlanV0(charter: Charter, charterHash: Hash, inviteeHuman: string): Plan   // contract → sections: context(joint, prose), interface(joint, interface), a.impl_notes(A), b.impl_notes(B), rollout(joint, rollout), risks(joint, risks); other types → context + notes
// meta.parties.B is the invitee_label until the hello arrives; it is part of plan v0 and never patched.

// render.ts
export function renderMarkdown(plan: Plan): string              // §2.8
export function markdownHash(plan: Plan): Hash                  // sha256Hash(renderMarkdown(plan))

// chain.ts
export type ChainVerdict = { ok: true } | { ok: false; code: 'CHAIN_GAP' | 'CHAIN_DUPLICATE' | 'CHAIN_FORK'; detail: string }
export class ChainTracker { check(env: Envelope): ChainVerdict; commit(env: Envelope): void; last(party: Party): { seq: number; id: Hash | null } }

// state.ts
export interface ReplayOptions { joinSecret?: Uint8Array; now?: string }
export interface PendingProposal { id: Hash; from: Party; type: 'propose' | 'counter' | 'amend'; patch: JsonPatchOp[]; kinds: DecisionKind[]; resultHash: Hash; baseVersion: number }
export interface ReplayResult {
  state: SessionState; charter: Charter | null; charterHash: Hash | null
  identities: Partial<Record<Party, Identity>>
  plan: Plan | null; planHash: Hash | null; version: number
  pending: PendingProposal | null
  signoffRequest: { id: Hash; from: Party; version: number; hash: Hash; mdHash: Hash } | null
  frozen: { version: number; hash: Hash; mdHash: Hash } | null
  signoffs: Partial<Record<Party, { id: Hash; statement: SignoffStatement; human_sig: string }>>
  final: { id: Hash; planHash: Hash } | null
  stored: Partial<Record<Party, Hash>>
  floor: Party | null
  turns: Record<Party, number>; turnBudget: Record<Party, number>; proposals: number
  noProgress: number; nudge: boolean; counterStreak: number
  deadlockReason: string | null
  awaitingHuman: Record<Party, boolean>
  checkpoints: Record<string, { party: Party; askedIn: Hash; answeredIn: Hash | null }>
  rejectedHashes: Hash[]
  accepted: Hash[]                                              // ids applied, in order
  rejected: { id: Hash; code: ErrorCode; detail: string }[]
  lastSeq: Record<Party, number>                                // for building the next envelope
  lastId: Record<Party, Hash | null>
}
export function replay(log: Envelope[], opts?: ReplayOptions): ReplayResult      // sorts by relay_seq when present, else keeps given order
export function validateNext(result: ReplayResult, env: Envelope, opts?: ReplayOptions): { ok: true } | { ok: false; code: ErrorCode; detail: string }  // would `env` be accepted next?
```

`replay` must call `verifyEnvelope` (from envelope.ts) on each message and reject failures with their code.

## Acceptance criteria

- **AC1** Worked transcript fixture (`test/fixtures/transcript.ts`, a builder that signs real envelopes): session_open → hello → welcome → say → propose (cursor pagination) → counter (adds total_count, with a `security_or_pii`-free patch) → accept → ask_user_pending → user_answer_summary → propose with `breaking_change` decision + checkpoint_ref → accept with checkpoint_ref → request_signoff → accept → signoff A → signoff B → plan_final → bye A → bye B. Final state `CLOSED`, version 2, no `rejected` entries.
- **AC2** Replaying the fixture twice (and once with messages shuffled but relay_seq set) yields identical `planHash`, identical `markdownHash`, and deep-equal results.
- **AC3** A message with a modified body (re-signed by a key that isn't a member) is rejected `UNKNOWN_SENDER`; with a body modified but not re-signed → `BAD_ID`; neither changes state.
- **AC4** One test per chain rule: gap, duplicate seq with different id, fork (wrong prev); exact duplicate id is ignored without a `rejected` entry.
- **AC5** Floor: B sending `say` when the floor is A's → `NOT_YOUR_FLOOR`; amend/withdraw by the non-proposer → rejected.
- **AC6** Proposal rules each with a test: missing version test → `BAD_PATCH`; wrong version → `STALE_BASE`; touching `/meta/parties` → `BAD_PATCH`; B editing `a.impl_notes` → `OWNER_VIOLATION`; second propose while pending → `PROPOSAL_PENDING`; re-proposing a rejected result → `RECREATES_REJECTED`; accept with wrong `result_hash` → `STALE_BASE`; proposals over budget → `BUDGET_EXHAUSTED`.
- **AC7** Checkpoints: proposing a decision with `kind: "breaking_change"` (in checkpoint_kinds) without `checkpoint_ref` → `CHECKPOINT_SKIPPED`; accepting it with a ref that predates the proposal → `CHECKPOINT_SKIPPED`; a decision with a checkpoint kind added via patch without declaring it in `kinds` is still caught.
- **AC8** Freeze: `request_signoff` with a blocking open item → `INVALID_STATE`; propose while frozen → `INVALID_STATE`; `unfreeze` returns to `DISCUSSING`; a signoff with a wrong `md_hash` or signed by the agent key instead of the human key → `SIGNOFF_MISMATCH`; `decline` voids the other party's approve.
- **AC9** Termination: hitting `no_progress_nudge` sets `nudge`; `no_progress_deadlock` → `DEADLOCKED`; 3 consecutive counters → `DEADLOCKED`; `resolve extend` returns to `DISCUSSING` with extended budgets; turn budget exhaustion → `DEADLOCKED`; `opts.now` past expiry while `INVITED` → `EXPIRED`.
- **AC10** `renderMarkdown` ends with a single `\n`, has no `\r` or trailing spaces, lists agent-assumed decisions before others, and a snapshot test pins its output for the fixture's final plan.
- **AC11** `validateNext` agrees with `replay` (for every message in the fixture and every negative test, `validateNext(replay(prefix), msg).ok` equals "msg was accepted").
- **AC12** `bun run check` passes.
