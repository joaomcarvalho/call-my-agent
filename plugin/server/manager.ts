import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_BUDGETS,
  agreementFileName,
  base64urlDecode,
  base64urlEncode,
  bytesToHex,
  createPlanV0,
  decodeInvite,
  deriveBootstrapKey,
  encodeInvite,
  fingerprint,
  fourWordCode,
  generateJoinSecret,
  generateX25519,
  hashObject,
  inviteCode,
  joinProof,
  markdownHash,
  openEnvelope,
  planHash,
  renderAgreementFile,
  renderMarkdown,
  replay,
  secretHash,
  sha256Hash,
  verifyEnvelope,
  type CallType,
  type Charter,
  type DecisionKind,
  type Envelope,
  type Evidence,
  type Hash,
  type Identity,
  type Invite,
  type JsonPatchOp,
  type Mode,
  type Party,
  type RejectReason,
} from '@cma/protocol';
import { RelayClient, RelayHttpError, type RelayMsg } from '@cma/relay';
import { CallRuntime, ToolError, agentSigner, errorText, type RuntimeHooks } from './call.ts';
import { badge, fenceInvite, fencePlan, floorLabel, formatInjection, messageLine, sanitizeLabel, type InjectionHeader } from './format.ts';
import { Inbox, wakeOf, type InboxItem } from './inbox.ts';
import {
  SESSION_ID,
  acquireOwnerLock,
  callPaths,
  listSessions,
  loadOrCreateIdentity,
  readCallRecord,
  readPendingJoin,
  releaseOwnerLock,
  removePendingJoin,
  writeCallRecord,
  writePendingJoin,
  type CallRecord,
  type LocalIdentity,
  type Profile,
} from './store.ts';

/** `charter.checkpoint_kinds` of every call this server starts. */
export const CHECKPOINT_KINDS: DecisionKind[] = ['breaking_change', 'security_or_pii', 'deadline_commitment', 'ownership_change'];
/** The relay's maximum room lifetime. */
const ROOM_TTL_S = 259200;
export const DEFAULT_RELAY_URL = 'http://127.0.0.1:8787';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Bounds on the caller-chosen charter text an invite may carry. */
export const INVITE_LIMITS = { shareSetEntries: 20, shareSetEntryChars: 200, topicChars: 200, inviteeLabelChars: 100 } as const;

export const NOT_CALL_SESSION_DETAIL =
  'call-my-agent tools only work in a call session. Ask your human to start one in a terminal with `cma session <dir> --exec`.';

export interface CallManagerOptions {
  home: string;
  relayUrl?: string;
  /** Where `cma_write_plan` writes `docs/agreements/`; recorded per call when it is created. */
  repoRoot?: string;
  /** Source of the messaging socket variables and of `CMA_CALL_SESSION`. */
  env?: Record<string, string | undefined>;
  /** Acts as a call session without `CMA_CALL_SESSION=1` in `env`. The owner lock still applies. */
  assumeCallSession?: boolean;
  /** Used only when `identity/profile.json` does not exist yet. */
  profile?: Partial<Profile>;
  batchMs?: number;
  sendTimeoutMs?: number;
  signoffPollMs?: number;
}

export type ToolResult = Record<string, unknown>;

export interface StartCallInput {
  peer: string;
  topic: string;
  type?: CallType;
  mode?: Mode;
  share_set?: string[];
}
export interface SessionInput {
  session: string;
}
export interface SayInput extends SessionInput {
  text: string;
  evidence?: Evidence[];
}
export interface ProposeInput extends SessionInput {
  patch: JsonPatchOp[];
  kinds?: DecisionKind[];
  rationale: string;
  checkpoint_ref?: string;
}
export interface RespondInput extends SessionInput {
  action: 'accept' | 'reject' | 'counter';
  reasons?: (string | RejectReason)[];
  patch?: JsonPatchOp[];
  kinds?: DecisionKind[];
  rationale?: string;
  checkpoint_ref?: string;
}
export interface CheckpointInput extends SessionInput {
  question: string;
  kind?: DecisionKind;
  blocks?: string[];
}
export interface AnswerInput extends SessionInput {
  checkpoint_id: string;
  shareable_summary: string;
}
export interface PlanGetInput extends SessionInput {
  format?: 'markdown' | 'json';
  version?: number;
}
export interface WaitInput extends SessionInput {
  timeout_s?: number;
}
export interface HangupInput extends SessionInput {
  reason?: string;
}

interface Opening {
  token: string;
  charter: Charter;
  charterHash: Hash;
}

function newSessionId(): string {
  return `ses_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => BASE32[b % 32]).join('')}`;
}

function withVersionTest(patch: JsonPatchOp[], version: number): JsonPatchOp[] {
  const first = patch[0];
  if (first && first.op === 'test' && first.path === '/version') return patch;
  return [{ op: 'test', path: '/version', value: version }, ...patch];
}

function parseInvite(text: string): Invite {
  let invite: Invite;
  try {
    invite = decodeInvite(text);
  } catch (err) {
    throw new ToolError('BAD_INVITE', errorText(err));
  }
  if (!SESSION_ID.test(invite.session)) throw new ToolError('BAD_INVITE', 'the session id has unexpected characters');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(invite.room)) throw new ToolError('BAD_INVITE', 'the room id has unexpected characters');
  try {
    inviteCode(invite.room);
  } catch (err) {
    throw new ToolError('BAD_INVITE', errorText(err));
  }
  let url: URL;
  try {
    url = new URL(invite.relay);
  } catch {
    throw new ToolError('BAD_INVITE', 'the relay is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolError('BAD_INVITE', 'the relay must be an http(s) URL');
  return invite;
}

/** Why a charter is outside INVITE_LIMITS, or null. */
function charterLimitProblem(c: Pick<Charter, 'topic' | 'invitee_label' | 'share_set'>): string | null {
  const L = INVITE_LIMITS;
  if (c.share_set.length > L.shareSetEntries) return `the share set has more than ${L.shareSetEntries} entries`;
  if (c.share_set.some((entry) => entry.length > L.shareSetEntryChars)) return `a share set entry is longer than ${L.shareSetEntryChars} characters`;
  if (c.topic.length > L.topicChars) return `the topic is longer than ${L.topicChars} characters`;
  if (c.invitee_label.length > L.inviteeLabelChars) return `the invitee label is longer than ${L.inviteeLabelChars} characters`;
  return null;
}

/** Writes `text` to a new file at `path`; an existing byte-identical file also counts. Null when a different file is there. */
function writeAgreement(path: string, text: string): string | null {
  try {
    writeFileSync(path, text, { flag: 'wx' });
    return path;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  try {
    return readFileSync(path, 'utf8') === text ? path : null;
  } catch {
    return null;
  }
}

function relayJoinError(err: unknown): ToolError {
  if (err instanceof RelayHttpError) {
    if (err.status === 403) return new ToolError('JOIN_PROOF_INVALID', 'the relay refused the invite secret or the seat-resume proof');
    if (err.status === 404) return new ToolError('BAD_INVITE', 'the relay does not know this room');
    if (err.status === 409) return new ToolError('INVALID_STATE', 'another agent has already joined this call');
    if (err.status === 410) return new ToolError('INVALID_STATE', 'the call room has expired');
  }
  return new ToolError('RELAY_UNAVAILABLE', errorText(err));
}

/** Differences between what the invite promises and the session_open actually in the room. */
function openingMismatches(invite: Invite, opening: Opening): string[] {
  const out: string[] = [];
  if (opening.charter.inviter.agent_key !== invite.fp) {
    out.push(`the session was opened by key ${fingerprint(opening.charter.inviter.agent_key)}, not the invite's ${fingerprint(invite.fp)}`);
  }
  if (opening.charterHash !== invite.charter_hash) out.push('the charter in the room differs from the one the invite names');
  if (opening.charter.session !== invite.session) out.push('the charter is for a different session');
  return out;
}

/** Tool-shaped operations over the calls of one CMA home. */
export class CallManager {
  readonly root: string;
  private readonly calls = new Map<string, CallRuntime>();
  private readonly inbox: Inbox;
  private readonly relayUrl: string;
  private readonly repoRoot: string;
  private readonly hooks: RuntimeHooks;
  private readonly callSession: boolean;
  private readonly ownerId = crypto.randomUUID();
  private readonly owned = new Set<string>();
  private local: LocalIdentity | null = null;

  constructor(private readonly opts: CallManagerOptions) {
    this.root = opts.home;
    this.callSession = opts.assumeCallSession === true || opts.env?.CMA_CALL_SESSION === '1';
    this.relayUrl = (opts.relayUrl ?? DEFAULT_RELAY_URL).replace(/\/+$/, '');
    this.repoRoot = opts.repoRoot ?? process.cwd();
    this.inbox = new Inbox({
      root: this.root,
      env: opts.env ?? {},
      batchMs: opts.batchMs,
      header: (session) => this.header(session),
      audit: (session, record) => this.calls.get(session)?.audit(record),
    });
    this.hooks = {
      deliver: (rt, env) => this.deliver(rt, env),
      poke: (rt) => this.inbox.poke(rt.session),
    };
  }

  /** Loads every call on disk that no other live server owns and reconnects the open ones. Outside a call session, none. */
  async init(): Promise<void> {
    if (!this.callSession) return;
    for (const session of listSessions(this.root)) {
      if (this.calls.has(session)) continue;
      if (!this.claim(session)) continue;
      let record: CallRecord;
      try {
        record = readCallRecord(this.root, session);
      } catch {
        this.unclaim(session);
        continue;
      }
      const rt = this.attach(record);
      if (rt.terminal) continue;
      try {
        await rt.connect();
      } catch (err) {
        rt.audit({ kind: 'relay_error', detail: errorText(err) });
      }
    }
  }

  async close(): Promise<void> {
    this.inbox.close();
    await Promise.all([...this.calls.values()].map((rt) => rt.stop()));
    for (const session of [...this.owned]) this.unclaim(session);
  }

  /** The call's runtime, attaching it first when it is on disk and no other live server owns it. */
  runtime(session: string): CallRuntime {
    this.guard();
    return this.calls.get(session) ?? this.adopt(session);
  }

  identity(): LocalIdentity {
    this.local ??= loadOrCreateIdentity(this.root, this.opts.profile);
    return this.local;
  }

  // ---------------------------------------------------------------- tools

  async startCall(input: StartCallInput): Promise<ToolResult> {
    this.guard();
    const limit = charterLimitProblem({ topic: input.topic, invitee_label: input.peer, share_set: input.share_set ?? [] });
    if (limit) throw new ToolError('BAD_INVITE', `the peer would refuse this invite: ${limit}`);
    const id = this.identity();
    const type = input.type ?? 'contract';
    const mode = input.mode ?? 'org';
    const budgets = DEFAULT_BUDGETS[mode];
    const session = newSessionId();
    const secret = generateJoinSecret();
    const x = generateX25519();
    const created = Date.now();
    // The room must outlive a call welcomed at the last moment of the invite.
    const expiresAt = new Date(created + (ROOM_TTL_S - budgets.ttl_s) * 1000).toISOString();
    const charter: Charter = {
      session,
      topic: input.topic,
      type,
      mode,
      template: type,
      inviter: this.ownIdentity(id, x.publicHex),
      invitee_label: input.peer,
      share_set: input.share_set ?? [],
      budgets,
      checkpoint_kinds: CHECKPOINT_KINDS,
      created_at: new Date(created).toISOString(),
      expires_at: expiresAt,
    };
    const charterHash = hashObject(charter);
    const plan = createPlanV0(charter, charterHash, charter.invitee_label);
    let room: string;
    let token: string;
    try {
      ({ room, token } = await RelayClient.createRoom(this.relayUrl, { secretHash: secretHash(secret), creatorKey: id.agent.keyId, ttlS: ROOM_TTL_S }));
    } catch (err) {
      throw new ToolError('RELAY_UNAVAILABLE', `cannot create a room on ${this.relayUrl}: ${errorText(err)}`);
    }
    const invite = encodeInvite({
      v: 1,
      relay: this.relayUrl,
      room,
      session,
      secret: base64urlEncode(secret),
      fp: id.agent.keyId,
      charter_hash: charterHash,
      exp: expiresAt,
    });
    const record: CallRecord = {
      session,
      party: 'A',
      relay: this.relayUrl,
      room,
      token,
      secret: base64urlEncode(secret),
      invite,
      charter_hash: charterHash,
      x25519_secret: bytesToHex(x.secretKey),
      cursor: 0,
      repo_root: this.repoRoot,
    };
    if (!this.claim(session)) throw new ToolError('INVALID_STATE', `call ${session} is owned by another session`);
    writeCallRecord(this.root, record);
    const rt = this.attach(record);
    await rt.connect();
    await rt.send('session_open', { charter, charter_hash: charterHash, plan_v0: plan, plan_v0_hash: planHash(plan) });
    return { ...this.base(rt), invite, fingerprint: fingerprint(id.agent.keyId), expires_at: expiresAt };
  }

  async inspectInvite(input: { invite: string }): Promise<ToolResult> {
    this.guard();
    const invite = parseInvite(input.invite);
    const opening = await this.fetchOpening(invite);
    const { charter } = opening;
    const limit = charterLimitProblem(charter);
    if (limit) throw new ToolError('BAD_INVITE', `refusing this invite: ${limit}`);
    const problems = openingMismatches(invite, opening);
    const now = Date.now();
    if (Date.parse(invite.exp) <= now || Date.parse(charter.expires_at) <= now) problems.push('the invite has expired');
    if (this.calls.has(invite.session)) problems.push('this call already exists on this machine');
    return {
      session: invite.session,
      code: inviteCode(invite.room),
      state: 'INVITED',
      floor: null,
      version: 0,
      awaiting_human: { you: false, peer: false },
      type: charter.type,
      mode: charter.mode,
      inviter: { fingerprint: fingerprint(charter.inviter.agent_key), assurance: charter.inviter.assurance },
      fingerprint: fingerprint(charter.inviter.agent_key),
      charter: fenceInvite(invite.session, [
        `topic: ${sanitizeLabel(charter.topic, INVITE_LIMITS.topicChars)}`,
        `inviter: ${sanitizeLabel(charter.inviter.human)} (${sanitizeLabel(badge(charter.inviter, charter.mode))})`,
        `invitee_label: ${sanitizeLabel(charter.invitee_label, INVITE_LIMITS.inviteeLabelChars)}`,
        `share_set:${charter.share_set.length === 0 ? ' (none)' : ''}`,
        ...charter.share_set.map((path) => `- ${sanitizeLabel(path, INVITE_LIMITS.shareSetEntryChars)}`),
      ]),
      budgets: { turns_per_party: charter.budgets.turns_per_party, proposals: charter.budgets.proposals, ttl_s: charter.budgets.ttl_s },
      checkpoint_kinds: charter.checkpoint_kinds,
      expires_at: charter.expires_at,
      problems,
    };
  }

  async joinCall(input: { invite: string }): Promise<ToolResult> {
    this.guard();
    const invite = parseInvite(input.invite);
    if (this.calls.has(invite.session) || existsSync(callPaths(this.root, invite.session).call)) {
      const existing = this.runtime(invite.session);
      if (existing.party === 'B') return this.joinResult(existing);
      throw new ToolError('INVALID_STATE', 'this machine started the call; it cannot also join it');
    }
    if (Date.parse(invite.exp) <= Date.now()) throw new ToolError('INVALID_STATE', `the invite expired at ${invite.exp}`);
    const id = this.identity();
    const opening = await this.fetchOpening(invite);
    const limit = charterLimitProblem(opening.charter);
    if (limit) throw new ToolError('BAD_INVITE', `refusing this invite: ${limit}`);
    const mismatches = openingMismatches(invite, opening);
    if (mismatches.length > 0) throw new ToolError('CHARTER_MISMATCH', `refusing to join: ${mismatches.join('; ')}`);
    const x = generateX25519();
    const record: CallRecord = {
      session: invite.session,
      party: 'B',
      relay: invite.relay,
      room: invite.room,
      token: opening.token,
      secret: invite.secret,
      invite: input.invite.trim(),
      charter_hash: opening.charterHash,
      x25519_secret: bytesToHex(x.secretKey),
      peer: opening.charter.inviter,
      cursor: 0,
      repo_root: this.repoRoot,
    };
    if (!this.claim(invite.session)) throw new ToolError('UNKNOWN_CALL', `call ${invite.session} is owned by another session on this machine`);
    writeCallRecord(this.root, record);
    removePendingJoin(this.root, invite.session);
    const rt = this.attach(record);
    await rt.connect();
    await rt.send('hello', {
      charter_hash: opening.charterHash,
      join_proof: joinProof(base64urlDecode(invite.secret), invite.session),
      identity: this.ownIdentity(id, x.publicHex),
    });
    return this.joinResult(rt);
  }

  async say(input: SayInput): Promise<ToolResult> {
    const rt = this.runtime(input.session);
    await rt.send('say', { text: input.text, ...(input.evidence && input.evidence.length > 0 ? { evidence: input.evidence } : {}) });
    return this.base(rt);
  }

  async propose(input: ProposeInput): Promise<ToolResult> {
    const rt = this.runtime(input.session);
    const env = await rt.send('propose', {
      patch: withVersionTest(input.patch, rt.current().version),
      kinds: input.kinds ?? [],
      rationale: input.rationale,
      ...(input.checkpoint_ref ? { checkpoint_ref: input.checkpoint_ref } : {}),
    });
    return { ...this.base(rt), proposal: env.id, result_hash: rt.result.pending?.resultHash ?? null };
  }

  async respond(input: RespondInput): Promise<ToolResult> {
    const rt = this.runtime(input.session);
    const r = rt.current();
    const target = r.pending
      ? { id: r.pending.id, result: r.pending.resultHash }
      : r.signoffRequest
        ? { id: r.signoffRequest.id, result: r.signoffRequest.hash }
        : null;
    if (!target) throw new ToolError('NO_SUCH_PROPOSAL', 'there is no pending proposal or sign-off request');
    const reasons = (input.reasons ?? []).map((reason) => (typeof reason === 'string' ? { text: reason } : reason));
    const ref = input.checkpoint_ref ? { checkpoint_ref: input.checkpoint_ref } : {};
    if (input.action === 'accept') {
      await rt.send('accept', { proposal: target.id, result_hash: target.result, ...ref });
      return { ...this.base(rt), plan_hash: rt.result.planHash };
    }
    if (input.action === 'reject') {
      await rt.send('reject', { proposal: target.id, reasons });
      return this.base(rt);
    }
    if (!input.patch || input.rationale === undefined) throw new ToolError('BAD_PATCH', 'counter needs a patch and a rationale');
    const env = await rt.send('counter', {
      proposal: target.id,
      reasons,
      patch: withVersionTest(input.patch, r.version),
      kinds: input.kinds ?? [],
      rationale: input.rationale,
      ...ref,
    });
    return { ...this.base(rt), proposal: env.id, result_hash: rt.result.pending?.resultHash ?? null };
  }

  async withdraw(input: SessionInput): Promise<ToolResult> {
    const rt = this.runtime(input.session);
    const pending = rt.current().pending;
    if (!pending) throw new ToolError('NO_SUCH_PROPOSAL', 'there is no pending proposal');
    await rt.send('withdraw', { proposal: pending.id });
    return this.base(rt);
  }

  async checkpoint(input: CheckpointInput): Promise<ToolResult> {
    const rt = this.runtime(input.session);
    const mine = Object.values(rt.current().checkpoints).filter((c) => c.party === rt.party).length;
    const checkpointId = `cp-${rt.party.toLowerCase()}-${mine + 1}`;
    await rt.send('ask_user_pending', {
      checkpoint_id: checkpointId,
      reason: input.kind ? 'checkpoint' : 'question',
      ...(input.kind ? { kind: input.kind } : {}),
      blocks: input.blocks ?? [],
    });
    rt.audit({ kind: 'checkpoint', checkpoint_id: checkpointId, question: input.question, decision_kind: input.kind ?? null });
    return { ...this.base(rt), checkpoint_id: checkpointId };
  }

  async answerCheckpoint(input: AnswerInput): Promise<ToolResult> {
    const rt = this.runtime(input.session);
    const env = await rt.send('user_answer_summary', { checkpoint_id: input.checkpoint_id, summary: input.shareable_summary });
    return { ...this.base(rt), checkpoint_ref: env.id };
  }

  async requestSignoff(input: SessionInput): Promise<ToolResult> {
    const rt = this.runtime(input.session);
    const r = rt.current();
    if (!r.plan || !r.planHash) throw new ToolError('INVALID_STATE', 'there is no plan yet');
    const mdHash = markdownHash(r.plan);
    const env = await rt.send('request_signoff', { version: r.version, hash: r.planHash, md_hash: mdHash });
    return { ...this.base(rt), request: env.id, plan_hash: r.planHash, md_hash: mdHash };
  }

  planGet(input: PlanGetInput): ToolResult {
    const rt = this.runtime(input.session);
    const r = rt.current();
    const plan = input.version === undefined ? r.plan : rt.planAt(input.version);
    if (!plan) throw new ToolError('INVALID_STATE', input.version === undefined ? 'there is no plan yet' : `there is no plan version ${input.version}`);
    const markdown = renderMarkdown(plan);
    const fenced = (content: string): string => fencePlan(rt.session, inviteCode(rt.record.room), plan.version, content);
    return {
      ...this.base(rt),
      plan_version: plan.version,
      plan_hash: planHash(plan),
      md_hash: sha256Hash(markdown),
      ...(input.format === 'json' ? { plan: fenced(JSON.stringify(plan)) } : { markdown: fenced(markdown) }),
    };
  }

  status(input: { session?: string } = {}): ToolResult {
    this.guard();
    if (input.session) return this.statusOf(this.runtime(input.session));
    const open = [...this.calls.values()].filter((rt) => !rt.terminal);
    return open.length === 1 ? this.statusOf(open[0]!) : this.listCalls();
  }

  listCalls(): ToolResult {
    this.guard();
    const calls = [...this.calls.values()]
      .sort((a, b) => a.session.localeCompare(b.session))
      .map((rt) => {
        return {
          ...this.base(rt),
          party: rt.party,
          peer: this.peerName(rt),
          open_checkpoints: this.openCheckpoints(rt).length,
        };
      });
    return { calls };
  }

  async wait(input: WaitInput): Promise<ToolResult> {
    const rt = this.runtime(input.session);
    const timeoutMs = Math.min(Math.max(input.timeout_s ?? 60, 0), 300) * 1000;
    const items = rt.terminal ? this.inbox.take(rt.session) : await this.inbox.wait(rt.session, timeoutMs);
    return this.withMessages(rt, items);
  }

  inboxRead(input: SessionInput): ToolResult {
    const rt = this.runtime(input.session);
    return this.withMessages(rt, this.inbox.take(rt.session));
  }

  async hangup(input: HangupInput): Promise<ToolResult> {
    const rt = this.runtime(input.session);
    if (!rt.terminal) await rt.send('abort', { reason: input.reason ?? 'ended by user' });
    return this.base(rt);
  }

  async writePlan(input: SessionInput): Promise<ToolResult> {
    const rt = this.runtime(input.session);
    const r = rt.current();
    if (r.state !== 'AGREED' || !r.final) {
      throw new ToolError('INVALID_STATE', r.state === 'AGREED' ? 'waiting for plan_final' : `the plan can only be written in AGREED, not ${r.state}`);
    }
    const { plan, charter } = r;
    const A = r.identities.A;
    const B = r.identities.B;
    const sA = r.signoffs.A;
    const sB = r.signoffs.B;
    if (!plan || !charter || !A || !B || !sA || !sB) throw new ToolError('INVALID_STATE', 'the agreed plan is incomplete');
    let text: string;
    try {
      text = renderAgreementFile({
        plan,
        charter,
        identities: { A, B },
        signoffs: { A: { statement: sA.statement, human_sig: sA.human_sig }, B: { statement: sB.statement, human_sig: sB.human_sig } },
      });
    } catch (err) {
      throw new ToolError('SIGNOFF_MISMATCH', errorText(err));
    }
    const name = agreementFileName(plan, charter);
    const dir = join(rt.record.repo_root, 'docs', 'agreements');
    mkdirSync(dir, { recursive: true });
    const path =
      writeAgreement(join(dir, name), text) ?? writeAgreement(join(dir, `${name.slice(0, -'.md'.length)}-${rt.session.slice(0, 8)}.md`), text);
    if (!path) throw new ToolError('INVALID_STATE', `docs/agreements/ already holds different files named ${name} and its per-session variant`);
    rt.agreementPath = path;
    rt.audit({ kind: 'agreement_written', path, plan_hash: r.final.planHash });
    if (!r.stored[rt.party]) await rt.send('bye', { stored: r.final.planHash });
    return { ...this.base(rt), path, plan_hash: r.final.planHash, md_hash: markdownHash(plan) };
  }

  // ---------------------------------------------------------------- internals

  private guard(): void {
    if (!this.callSession) throw new ToolError('NOT_CALL_SESSION', NOT_CALL_SESSION_DETAIL);
  }

  /** Takes the call's owner lock for this server; false when another live server holds it. */
  private claim(session: string): boolean {
    if (acquireOwnerLock(this.root, session, this.ownerId) !== null) return false;
    this.owned.add(session);
    return true;
  }

  private unclaim(session: string): void {
    releaseOwnerLock(this.root, session, this.ownerId);
    this.owned.delete(session);
  }

  /** Attaches a call on disk that this server did not load, e.g. after the server that owned it died. */
  private adopt(session: string): CallRuntime {
    if (!SESSION_ID.test(session) || !existsSync(callPaths(this.root, session).call)) {
      throw new ToolError('UNKNOWN_CALL', `no call ${session} on this machine; see cma_list_calls`);
    }
    if (!this.claim(session)) throw new ToolError('UNKNOWN_CALL', `call ${session} is owned by another session on this machine`);
    let record: CallRecord;
    try {
      record = readCallRecord(this.root, session);
    } catch (err) {
      this.unclaim(session);
      throw new ToolError('UNKNOWN_CALL', `call ${session} cannot be loaded: ${errorText(err)}`);
    }
    const rt = this.attach(record);
    if (!rt.terminal) void rt.connect().catch((err: unknown) => rt.audit({ kind: 'relay_error', detail: errorText(err) }));
    return rt;
  }

  private attach(record: CallRecord): CallRuntime {
    const rt = new CallRuntime(this.root, record, this.identity(), this.hooks, {
      sendTimeoutMs: this.opts.sendTimeoutMs ?? 20_000,
      signoffPollMs: this.opts.signoffPollMs ?? 500,
    });
    this.calls.set(record.session, rt);
    return rt;
  }

  private deliver(rt: CallRuntime, env: Envelope): void {
    if (env.type === 'session_open' || env.type === 'heartbeat') return;
    this.inbox.push(rt.session, { relay_seq: env.relay_seq ?? 0, line: messageLine(env) }, wakeOf(env.type));
  }

  private ownIdentity(id: LocalIdentity, x25519: string): Identity {
    return {
      agent_key: id.agent.keyId,
      human_key: id.humanKey,
      human: id.profile.human,
      ...(id.profile.org ? { org: id.profile.org } : {}),
      assurance: 'self_asserted',
      x25519,
    };
  }

  /** True when this machine recorded the invite's relay URL for its session, in a pending join or in call.json. */
  private relayRecorded(invite: Invite): boolean {
    if (readPendingJoin(this.root, invite.session)?.relay === invite.relay) return true;
    if (!existsSync(callPaths(this.root, invite.session).call)) return false;
    try {
      return readCallRecord(this.root, invite.session).relay === invite.relay;
    } catch {
      return false;
    }
  }

  /**
   * Takes a relay seat for the invite and records it as a pending join. A first join sends no resume proof; a seat
   * this key already holds is resumed only on a relay URL this machine recorded for the session.
   */
  private async takeSeat(invite: Invite, how: 'join' | 'resume'): Promise<string> {
    const id = this.identity();
    let token: string;
    try {
      if (how === 'join') {
        try {
          ({ token } = await RelayClient.joinRoom(invite.relay, invite.room, { secret: invite.secret, memberKey: id.agent.keyId }));
        } catch (err) {
          if (!(err instanceof RelayHttpError && err.status === 403 && this.relayRecorded(invite))) throw err;
          token = await this.resumeSeat(invite);
        }
      } else {
        token = await this.resumeSeat(invite);
      }
    } catch (err) {
      throw relayJoinError(err);
    }
    writePendingJoin(this.root, { session: invite.session, relay: invite.relay, room: invite.room, token });
    return token;
  }

  private async resumeSeat(invite: Invite): Promise<string> {
    const id = this.identity();
    const { token } = await RelayClient.resumeSeat(invite.relay, invite.room, {
      memberKey: id.agent.keyId,
      secretHash: secretHash(base64urlDecode(invite.secret)),
      sign: agentSigner(id),
    });
    return token;
  }

  private async readRoom(invite: Invite, token: string): Promise<RelayMsg[]> {
    const msgs: RelayMsg[] = [];
    const client = new RelayClient({ relayUrl: invite.relay, room: invite.room, token, onMessage: (m) => msgs.push(m) });
    try {
      await client.connect();
    } finally {
      await client.close();
    }
    return msgs;
  }

  private async fetchOpening(invite: Invite): Promise<Opening> {
    const saved = readPendingJoin(this.root, invite.session);
    let token = saved && saved.relay === invite.relay && saved.room === invite.room ? saved.token : await this.takeSeat(invite, 'join');
    let msgs: RelayMsg[];
    try {
      msgs = await this.readRoom(invite, token);
    } catch (err) {
      if (!this.relayRecorded(invite)) throw new ToolError('RELAY_UNAVAILABLE', errorText(err));
      token = await this.takeSeat(invite, 'resume');
      try {
        msgs = await this.readRoom(invite, token);
      } catch (err) {
        throw new ToolError('RELAY_UNAVAILABLE', errorText(err));
      }
    }
    const first = msgs.sort((a, b) => a.relay_seq - b.relay_seq)[0];
    if (!first) throw new ToolError('INVALID_STATE', 'the caller has not opened this session yet');
    const secret = base64urlDecode(invite.secret);
    let raw: unknown;
    try {
      raw = openEnvelope(first.payload, { k0: deriveBootstrapKey(secret, invite.session) }, invite.session);
    } catch {
      throw new ToolError('CHARTER_MISMATCH', 'the first message in the room does not decrypt with this invite');
    }
    const verified = verifyEnvelope(raw);
    if (!verified.ok) throw new ToolError(verified.code, `session_open: ${verified.detail}`);
    const r = replay([{ ...verified.envelope, relay_seq: first.relay_seq }], { joinSecret: secret });
    const rejected = r.rejected[0];
    if (rejected || !r.charter || !r.charterHash) {
      throw new ToolError(rejected?.code ?? 'INVALID_STATE', `session_open: ${rejected?.detail ?? 'missing'}`);
    }
    return { token, charter: r.charter, charterHash: r.charterHash };
  }

  private joinResult(rt: CallRuntime): ToolResult {
    const r = rt.current();
    const inviter = r.charter?.inviter ?? rt.record.peer!;
    return {
      ...this.base(rt),
      peer: this.peerSummary(inviter, r.charter?.mode),
      fingerprint: fingerprint(inviter.agent_key),
      four_words: fourWordCode(inviter.agent_key, this.identity().agent.keyId),
    };
  }

  private base(rt: CallRuntime): ToolResult {
    const r = rt.current();
    const pending = this.inbox.pending(rt.session);
    return {
      session: rt.session,
      code: inviteCode(rt.record.room),
      state: r.state,
      floor: floorLabel(r.floor, rt.party),
      version: r.version,
      awaiting_human: { you: r.awaitingHuman[rt.party], peer: r.awaitingHuman[rt.other] },
      ...(r.nudge ? { nudge: 'several floor turns without a plan change: converge or defer' } : {}),
      ...(r.deadlockReason ? { deadlock_reason: r.deadlockReason } : {}),
      ...(pending > 0 ? { pending_inbound: pending } : {}),
    };
  }

  private statusOf(rt: CallRuntime): ToolResult {
    const r = rt.current();
    const me = rt.party;
    const who = (party: Party): 'you' | 'peer' => (party === me ? 'you' : 'peer');
    const peer = r.identities[rt.other];
    return {
      ...this.base(rt),
      party: me,
      peer: peer ? this.peerSummary(peer, r.charter?.mode) : { label: sanitizeLabel(r.charter?.invitee_label ?? ''), joined: false },
      peer_online: rt.peerOnline,
      ...(r.identities.A && r.identities.B ? { four_words: fourWordCode(r.identities.A.agent_key, r.identities.B.agent_key) } : {}),
      plan_hash: r.planHash,
      md_hash: r.plan ? markdownHash(r.plan) : null,
      pending: r.pending
        ? { id: r.pending.id, from: who(r.pending.from), type: r.pending.type, kinds: r.pending.kinds, base_version: r.pending.baseVersion, result_hash: r.pending.resultHash }
        : null,
      signoff_request: r.signoffRequest
        ? { id: r.signoffRequest.id, from: who(r.signoffRequest.from), version: r.signoffRequest.version, plan_hash: r.signoffRequest.hash, md_hash: r.signoffRequest.mdHash }
        : null,
      frozen: r.frozen ? { version: r.frozen.version, plan_hash: r.frozen.hash, md_hash: r.frozen.mdHash } : null,
      signoffs: { you: Boolean(r.signoffs[me]), peer: Boolean(r.signoffs[rt.other]) },
      final: r.final !== null,
      meter: {
        turns: { you: r.turns[me], peer: r.turns[rt.other] },
        turn_budget: r.turnBudget[me],
        proposals: r.proposals,
        proposal_budget: r.charter?.budgets.proposals ?? null,
      },
      open_checkpoints: this.openCheckpoints(rt),
      ...(rt.agreementPath ? { agreement: rt.agreementPath } : {}),
    };
  }

  private openCheckpoints(rt: CallRuntime): string[] {
    return Object.entries(rt.result.checkpoints)
      .filter(([, c]) => c.party === rt.party && c.answeredIn === null)
      .map(([id]) => id);
  }

  private peerSummary(identity: Identity, mode: Mode | undefined): ToolResult {
    return {
      human: sanitizeLabel(identity.human),
      ...(identity.org ? { org: sanitizeLabel(identity.org) } : {}),
      badge: sanitizeLabel(badge(identity, mode)),
      fingerprint: fingerprint(identity.agent_key),
      assurance: identity.assurance,
    };
  }

  private peerName(rt: CallRuntime): string {
    const r = rt.result;
    return sanitizeLabel(r.identities[rt.other]?.human ?? r.charter?.invitee_label ?? rt.record.peer?.human ?? '');
  }

  private header(session: string): InjectionHeader | null {
    const rt = this.calls.get(session);
    if (!rt) return null;
    const r = rt.current();
    return {
      code: inviteCode(rt.record.room),
      peer: this.peerName(rt),
      badge: badge(r.identities[rt.other], r.charter?.mode),
      state: r.state,
      floor: floorLabel(r.floor, rt.party),
      version: r.version,
    };
  }

  private withMessages(rt: CallRuntime, items: InboxItem[]): ToolResult {
    const header = this.header(rt.session)!;
    return {
      ...this.base(rt),
      count: items.length,
      messages: items.length > 0 ? formatInjection(header, rt.session, items.map((item) => item.line)) : null,
    };
  }
}
