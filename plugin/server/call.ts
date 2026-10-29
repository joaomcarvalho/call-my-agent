import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import {
  PROTOCOL_VERSION,
  base64urlDecode,
  deriveBootstrapKey,
  deriveSessionKey,
  hexToBytes,
  openEnvelope,
  replay,
  sealEnvelope,
  signBytes,
  signEnvelope,
  validateNext,
  verifyEnvelope,
  verifySignoffSignature,
  type Envelope,
  type ErrorCode,
  type MessageType,
  type Party,
  type Plan,
  type ReplayOptions,
  type ReplayResult,
  type SessionState,
  type SignoffBody,
} from '@cma/protocol';
import { RelayClient, RelayError, type RelayMsg, type SignFn } from '@cma/relay';
import { appendAudit, appendLog, callPaths, readLog, writeCallRecord, type AuditRecord, type CallPaths, type CallRecord, type LocalIdentity } from './store.ts';

export type ToolErrorCode = ErrorCode | 'UNKNOWN_CALL' | 'BAD_INVITE' | 'RELAY_UNAVAILABLE';

/** Reported to the model as a tool error carrying `code`. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ToolError';
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Signs relay seat-resume proofs with the agent key. */
export function agentSigner(identity: LocalIdentity): SignFn {
  return (bytes) => signBytes(bytes, identity.agent.secretKey);
}

export const TERMINAL_STATES: ReadonlySet<SessionState> = new Set(['CLOSED', 'DECLINED', 'ABORTED', 'EXPIRED']);
const BOOTSTRAP_TYPES: ReadonlySet<MessageType> = new Set(['session_open', 'hello']);

export interface RuntimeHooks {
  /** An accepted message from the peer. */
  deliver(rt: CallRuntime, env: Envelope): void;
  /** The state changed without a peer message, e.g. the server sent something on its own. */
  poke(rt: CallRuntime): void;
}

export interface RuntimeTiming {
  sendTimeoutMs: number;
  signoffPollMs: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(what)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** One call: relay connection, keys, log.jsonl, the replayed state, outbound sends and the signoff watcher. */
export class CallRuntime {
  readonly session: string;
  readonly party: Party;
  readonly other: Party;
  readonly paths: CallPaths;
  record: CallRecord;
  log: Envelope[];
  result: ReplayResult;
  peerOnline = false;
  agreementPath: string | null = null;

  private client: RelayClient | null = null;
  private connected = false;
  private stopped = false;
  private readonly secret: Uint8Array;
  private readonly k0: Uint8Array;
  private k1: Uint8Array | null = null;
  private readonly ids = new Set<string>();
  private readonly echoes = new Map<string, { resolve(): void; reject(err: Error): void }>();
  private chain: Promise<unknown> = Promise.resolve();
  private watcher: ReturnType<typeof setInterval> | null = null;
  private signoffBusy = false;
  private readonly autoQueued = new Set<'welcome' | 'plan_final'>();

  constructor(
    private readonly root: string,
    record: CallRecord,
    private readonly identity: LocalIdentity,
    private readonly hooks: RuntimeHooks,
    private readonly timing: RuntimeTiming,
  ) {
    this.session = record.session;
    this.party = record.party;
    this.other = record.party === 'A' ? 'B' : 'A';
    this.paths = callPaths(root, record.session);
    this.secret = base64urlDecode(record.secret);
    this.k0 = deriveBootstrapKey(this.secret, this.session);
    this.log = readLog(root, this.session).sort((a, b) => (a.relay_seq ?? 0) - (b.relay_seq ?? 0));
    for (const env of this.log) this.ids.add(env.id);
    const head = this.log.reduce((max, env) => Math.max(max, env.relay_seq ?? 0), 0);
    this.record = head > record.cursor ? { ...record, cursor: head } : record;
    this.result = replay(this.log, this.replayOptions());
  }

  get terminal(): boolean {
    return TERMINAL_STATES.has(this.result.state);
  }

  /** The replayed state, re-evaluated against the clock once a deadline has passed. */
  current(): ReplayResult {
    if (!this.terminal && this.pastDeadline()) {
      this.result = replay(this.log, this.replayOptions());
      this.afterChange();
    }
    return this.result;
  }

  /** Connects with the stored token; if the relay refuses it, resumes the seat with the agent key and retries once. */
  async connect(): Promise<void> {
    if (this.client || this.stopped || this.terminal) return;
    try {
      await this.open();
    } catch (refused) {
      try {
        await this.resumeSeat();
        await this.open();
      } catch (err) {
        throw new ToolError('RELAY_UNAVAILABLE', `cannot reach the relay at ${this.record.relay}: ${errorText(refused)}; ${errorText(err)}`);
      }
    }
    this.connected = true;
    this.afterChange();
  }

  private async open(): Promise<void> {
    const client = new RelayClient({
      relayUrl: this.record.relay,
      room: this.record.room,
      token: this.record.token,
      cursor: this.record.cursor,
      onMessage: (m) => this.onMessage(m),
      onPresence: (p) => {
        if (p.member_key !== this.identity.agent.keyId) this.peerOnline = p.online;
      },
      onError: (e) => this.audit({ kind: 'relay_error', code: e.code, detail: e.detail }),
    });
    this.client = client;
    try {
      await client.connect();
    } catch (err) {
      if (this.client === client) this.client = null;
      throw err;
    }
  }

  private async resumeSeat(): Promise<void> {
    const { token } = await RelayClient.resumeSeat(this.record.relay, this.record.room, {
      memberKey: this.identity.agent.keyId,
      sign: agentSigner(this.identity),
    });
    this.record = { ...this.record, token };
    writeCallRecord(this.root, this.record);
    this.audit({ kind: 'seat_resumed' });
  }

  /** Signs, validates against the current replay, seals and sends; resolves once the relay echo is in the log. */
  send(type: MessageType, body: object): Promise<Envelope> {
    return this.exclusive(() => this.sendNow(type, body));
  }

  /** Plan at `version`, replaying log prefixes for past versions. */
  planAt(version: number): Plan | null {
    if (version === this.result.version) return this.result.plan;
    if (version > this.result.version) return null;
    for (let i = 1; i <= this.log.length; i++) {
      const r = replay(this.log.slice(0, i), { joinSecret: this.secret });
      if (r.version === version && r.plan) return r.plan;
      if (r.version > version) break;
    }
    return null;
  }

  audit(record: AuditRecord): void {
    appendAudit(this.root, this.session, record);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopWatcher();
    for (const echo of this.echoes.values()) echo.reject(new ToolError('RELAY_UNAVAILABLE', 'the server is shutting down'));
    this.echoes.clear();
    await this.disconnect();
  }

  // ---------------------------------------------------------------- outbound

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private replayOptions(): ReplayOptions {
    return { joinSecret: this.secret, now: new Date().toISOString() };
  }

  private pastDeadline(): boolean {
    const { charter, state, welcomedAt } = this.result;
    if (!charter) return false;
    const now = Date.now();
    if (state === 'INVITED' || state === 'HANDSHAKE') return now > Date.parse(charter.expires_at);
    return welcomedAt !== null && now > Date.parse(welcomedAt) + charter.budgets.ttl_s * 1000;
  }

  private build(type: MessageType, body: object, r: ReplayResult): Envelope {
    const { agent, profile } = this.identity;
    return signEnvelope(
      {
        v: PROTOCOL_VERSION,
        session: this.session,
        from: { party: this.party, agent_key: agent.keyId, human: profile.human, ...(profile.org ? { org: profile.org } : {}) },
        to: [this.other],
        seq: r.lastSeq[this.party] + 1,
        prev: r.lastId[this.party],
        ack: { A: r.lastSeq.A, B: r.lastSeq.B },
        ts: new Date().toISOString(),
        type,
        body: JSON.parse(JSON.stringify(body)) as Record<string, unknown>,
      },
      agent.secretKey,
    );
  }

  private sessionKey(): Uint8Array | null {
    if (this.k1) return this.k1;
    const peerX = this.party === 'A' ? this.result.identities.B?.x25519 : this.result.charter?.inviter.x25519;
    if (!peerX) return null;
    this.k1 = deriveSessionKey(hexToBytes(this.record.x25519_secret), peerX, this.secret, this.session);
    return this.k1;
  }

  private expectEcho(id: string): Promise<void> {
    if (this.ids.has(id)) return Promise.resolve();
    const echoed = new Promise<void>((resolve, reject) => this.echoes.set(id, { resolve, reject }));
    echoed.catch(() => undefined);
    return echoed;
  }

  private async sendNow(type: MessageType, body: object): Promise<Envelope> {
    if (this.stopped) throw new ToolError('INVALID_STATE', 'this call is no longer running on this server');
    const r = this.current();
    const env = this.build(type, body, r);
    const verdict = validateNext(r, env, this.replayOptions());
    if (!verdict.ok) {
      this.audit({ kind: 'send_refused', type, code: verdict.code, detail: verdict.detail });
      throw new ToolError(verdict.code, verdict.detail);
    }
    const epoch = BOOTSTRAP_TYPES.has(type) ? 0 : 1;
    const key = epoch === 0 ? this.k0 : this.sessionKey();
    if (!key) throw new ToolError('INVALID_STATE', 'no session key yet: the peer has not joined');
    const payload = sealEnvelope(env, key, epoch);
    if (!this.client) await this.connect();
    const client = this.client;
    if (!client) throw new ToolError('RELAY_UNAVAILABLE', 'not connected to the relay');
    const echoed = this.expectEcho(env.id);
    try {
      const sent = await withTimeout(client.send(env.id, payload), this.timing.sendTimeoutMs, 'the relay did not confirm the send');
      this.audit({ kind: 'send', type, id: env.id, relay_seq: sent.relay_seq });
      await withTimeout(echoed, this.timing.sendTimeoutMs, 'the relay did not echo the message');
    } catch (err) {
      this.echoes.delete(env.id);
      if (err instanceof ToolError) throw err;
      if (err instanceof RelayError && err.code === 'TOO_LARGE') throw new ToolError('TOO_LARGE', err.message);
      throw new ToolError('RELAY_UNAVAILABLE', `${errorText(err)}; it may still be delivered, check cma_status before retrying`);
    }
    const rejected = this.result.rejected.find((x) => x.id === env.id);
    if (rejected) throw new ToolError(rejected.code, `the relay ordered another message first: ${rejected.detail}`);
    return env;
  }

  // ---------------------------------------------------------------- inbound

  private onMessage(m: RelayMsg): void {
    try {
      this.ingest(m);
    } catch (err) {
      this.audit({ kind: 'ingest_error', relay_seq: m.relay_seq, msg_id: m.msg_id, detail: errorText(err) });
      this.advance(m.relay_seq);
    }
  }

  private ingest(m: RelayMsg): void {
    if (m.relay_seq <= this.record.cursor) return;
    const drop = (kind: string, detail: string): void => {
      this.audit({ kind, relay_seq: m.relay_seq, msg_id: m.msg_id, detail });
      this.advance(m.relay_seq);
    };
    let raw: unknown;
    let epoch: unknown;
    try {
      epoch = (JSON.parse(m.payload) as { e?: unknown }).e;
      raw = openEnvelope(m.payload, { k0: this.k0, k1: this.sessionKey() ?? undefined }, this.session);
    } catch (err) {
      return drop('undecryptable', errorText(err));
    }
    const verified = verifyEnvelope(raw);
    if (!verified.ok) return drop('unverifiable', `${verified.code}: ${verified.detail}`);
    const env = verified.envelope;
    if (env.id !== m.msg_id) return drop('unverifiable', 'relay msg_id differs from the envelope id');
    if (epoch === 0 && !BOOTSTRAP_TYPES.has(env.type)) return drop('unverifiable', `${env.type} was sealed with the bootstrap key`);
    if (this.ids.has(env.id)) {
      this.advance(m.relay_seq);
      this.settleEcho(env.id);
      return;
    }

    const stamped: Envelope = { ...env, relay_seq: m.relay_seq };
    appendLog(this.root, this.session, stamped);
    this.log.push(stamped);
    this.ids.add(env.id);
    this.result = replay(this.log, this.replayOptions());
    this.advance(m.relay_seq);
    const rejected = this.result.rejected.find((x) => x.id === env.id);
    this.audit({
      kind: 'receive',
      relay_seq: m.relay_seq,
      id: env.id,
      type: env.type,
      from: env.from.party,
      outcome: rejected ? rejected.code : 'accepted',
      ...(rejected ? { detail: rejected.detail } : {}),
    });
    this.notePeer();
    this.settleEcho(env.id);
    if (!rejected && env.from.party !== this.party) this.hooks.deliver(this, stamped);
    this.afterChange();
  }

  private settleEcho(id: string): void {
    const echo = this.echoes.get(id);
    this.echoes.delete(id);
    echo?.resolve();
  }

  private advance(seq: number): void {
    if (seq <= this.record.cursor) return;
    this.record = { ...this.record, cursor: seq };
    writeCallRecord(this.root, this.record);
    this.client?.ack(seq);
  }

  private notePeer(): void {
    const peer = this.result.identities[this.other];
    if (!peer || this.record.peer?.agent_key === peer.agent_key) return;
    this.record = { ...this.record, peer };
    writeCallRecord(this.root, this.record);
  }

  // ---------------------------------------------------------------- automatic actions

  private afterChange(): void {
    if (this.stopped) return;
    const r = this.result;
    if (this.terminal) {
      this.stopWatcher();
      if (this.connected) void this.exclusive(() => this.disconnect());
      this.hooks.poke(this);
      return;
    }
    if (r.state === 'FROZEN' && !r.signoffs[this.party]) this.startWatcher();
    else this.stopWatcher();
    if (this.party === 'A' && r.state === 'HANDSHAKE') this.auto('welcome');
    if (this.party === 'A' && r.state === 'AGREED' && !r.final) this.auto('plan_final');
  }

  private async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connected = false;
    await client?.close();
  }

  /** A answers a valid hello with welcome and sends plan_final once both approvals are in. */
  private auto(kind: 'welcome' | 'plan_final'): void {
    if (this.autoQueued.has(kind)) return;
    this.autoQueued.add(kind);
    void this.exclusive(async () => {
      try {
        const r = this.current();
        if (kind === 'welcome' && r.state === 'HANDSHAKE' && r.charter) {
          await this.sendNow('welcome', { charter_hash: r.charterHash, identity: r.charter.inviter });
        } else if (kind === 'plan_final' && r.state === 'AGREED' && !r.final && r.frozen && r.signoffs.A && r.signoffs.B) {
          await this.sendNow('plan_final', { plan_hash: r.frozen.hash, md_hash: r.frozen.mdHash, signoffs: [r.signoffs.A.id, r.signoffs.B.id] });
        } else {
          return;
        }
        this.hooks.poke(this);
      } catch (err) {
        this.audit({ kind: 'auto_send_failed', type: kind, detail: errorText(err) });
      } finally {
        this.autoQueued.delete(kind);
      }
    });
  }

  // ---------------------------------------------------------------- signoff watcher

  private startWatcher(): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => this.pollSignoff(), this.timing.signoffPollMs);
  }

  private stopWatcher(): void {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
  }

  private pollSignoff(): void {
    if (this.signoffBusy || !existsSync(this.paths.signoff)) return;
    this.signoffBusy = true;
    void this.exclusive(() => this.submitSignoff()).finally(() => {
      this.signoffBusy = false;
    });
  }

  /** Checks signoff.json against the frozen plan and this machine's identity, then sends it. Never throws. */
  private async submitSignoff(): Promise<void> {
    const { signoff, signoffSent } = this.paths;
    try {
      const r = this.current();
      if (r.state !== 'FROZEN' || r.signoffs[this.party] || !existsSync(signoff)) return;
      let body: unknown;
      try {
        body = JSON.parse(readFileSync(signoff, 'utf8'));
      } catch {
        // A file that is still being written gets another poll before it is rejected.
        if (Date.now() - statSync(signoff).mtimeMs < 2000) return;
        return this.rejectSignoff('signoff.json is not valid JSON');
      }
      const problem = this.signoffProblem(body, r);
      if (problem) return this.rejectSignoff(problem);
      try {
        await this.sendNow('signoff', body as SignoffBody);
      } catch (err) {
        if (err instanceof ToolError && err.code !== 'RELAY_UNAVAILABLE') return this.rejectSignoff(`${err.code}: ${err.detail}`);
        this.audit({ kind: 'signoff_send_failed', detail: errorText(err) });
        return;
      }
      if (existsSync(signoff)) renameSync(signoff, signoffSent);
      this.audit({ kind: 'signoff_sent', decision: (body as SignoffBody).statement.decision });
      this.hooks.poke(this);
    } catch (err) {
      this.audit({ kind: 'signoff_error', detail: errorText(err) });
    }
  }

  private signoffProblem(body: unknown, r: ReplayResult): string | null {
    const b = body as Partial<SignoffBody> | null;
    if (typeof b !== 'object' || b === null || typeof b.human_sig !== 'string' || typeof b.statement !== 'object' || b.statement === null) {
      return 'signoff.json must be {"statement": {...}, "human_sig": "..."}';
    }
    const s = b.statement;
    const frozen = r.frozen!;
    const checks: [string, boolean][] = [
      ['v', s.v === PROTOCOL_VERSION],
      ['session', s.session === this.session],
      ['version', s.version === frozen.version],
      ['plan_hash', s.plan_hash === frozen.hash],
      ['md_hash', s.md_hash === frozen.mdHash],
      ['mode', s.mode === r.charter?.mode],
      ['charter_hash', s.charter_hash === r.charterHash],
      ['party', s.party === this.party],
      ['human', s.human === r.identities[this.party]?.human],
      ['human_key', s.human_key === this.identity.humanKey],
    ];
    const wrong = checks.find(([, ok]) => !ok);
    if (wrong) return `statement ${wrong[0]} does not match the frozen plan or this machine's human key`;
    if (!verifySignoffSignature(b as SignoffBody)) return 'human_sig does not verify';
    return null;
  }

  private rejectSignoff(reason: string): void {
    if (existsSync(this.paths.signoff)) renameSync(this.paths.signoff, this.paths.signoffRejected);
    this.audit({ kind: 'signoff_rejected', reason });
  }
}
