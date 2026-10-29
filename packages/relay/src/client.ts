import { base64urlDecode, sha256Hash } from '@cma/protocol';

export interface RelayMsg {
  relay_seq: number;
  msg_id: string;
  sender_key: string;
  payload: string;
  ts: string;
}

const RELAY_CODE = /^[A-Z_]{1,32}$/;

/** A non-2xx relay HTTP answer. The message is fixed; the relay's own text is kept only in `detail`. */
export class RelayHttpError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(`relay refused the request (HTTP ${status})`);
    this.name = 'RelayHttpError';
    this.status = status;
    this.detail = detail;
  }
}

/** A relay `error` frame. The message carries only a well-formed code; the relay's own text is kept only in `detail`. */
export class RelayError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`relay error ${RELAY_CODE.test(code) ? code : 'UNKNOWN'}`);
    this.name = 'RelayError';
    this.code = code;
    this.detail = detail;
  }
}

export interface RelayClientArgs {
  relayUrl: string;
  room: string;
  token: string;
  cursor?: number;
  onMessage(m: RelayMsg): void;
  onPresence?(p: { member_key: string; online: boolean }): void;
  onError?(e: { code: string; detail: string }): void;
}

interface Waiter {
  resolve(v: { relay_seq: number; dup: boolean }): void;
  reject(e: Error): void;
}
interface Pending {
  payload: string;
  waiters: Waiter[];
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new RelayHttpError(res.status, typeof data.error === 'string' ? data.error : res.statusText);
  return data;
}

export type SignFn = (bytes: Uint8Array) => string | Promise<string>;

/** The bytes a seat-resume proof signs: `cma-relay-resume|<room>|<secret_hash hex>|<ts>`. */
export function resumeProofBytes(room: string, secretHash: string, ts: string): Uint8Array {
  return new TextEncoder().encode(`cma-relay-resume|${room}|${secretHash}|${ts}`);
}

async function resumeProof(room: string, secretHash: string, sign: SignFn): Promise<{ ts: string; proof: string }> {
  const ts = new Date().toISOString();
  return { ts, proof: await sign(resumeProofBytes(room, secretHash, ts)) };
}

const hashOfSecret = (secret: string): string => sha256Hash(base64urlDecode(secret)).slice('sha256:'.length);

const MIN_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 5000;

export class RelayClient {
  static async createRoom(
    relayUrl: string,
    args: { secretHash: string; creatorKey: string; ttlS: number },
  ): Promise<{ room: string; token: string }> {
    const data = await postJson(`${relayUrl}/v1/rooms`, {
      secret_hash: args.secretHash,
      creator_key: args.creatorKey,
      ttl_s: args.ttlS,
    });
    return { room: data.room as string, token: data.creator_token as string };
  }

  /** Joins with the secret. Pass `sign` only to re-take a seat this key already holds; a first join sends no proof. */
  static async joinRoom(
    relayUrl: string,
    room: string,
    args: { secret: string; memberKey: string; sign?: SignFn },
  ): Promise<{ token: string }> {
    const data = await postJson(`${relayUrl}/v1/rooms/${room}/join`, {
      secret: args.secret,
      member_key: args.memberKey,
      ...(args.sign ? await resumeProof(room, hashOfSecret(args.secret), args.sign) : {}),
    });
    return { token: data.member_token as string };
  }

  /** Re-takes a seat without the secret; `secretHash` is the hex sha256 of the room's join secret. */
  static async resumeSeat(
    relayUrl: string,
    room: string,
    args: { memberKey: string; secretHash: string; sign: SignFn },
  ): Promise<{ token: string }> {
    const data = await postJson(`${relayUrl}/v1/rooms/${room}/resume`, {
      member_key: args.memberKey,
      ...(await resumeProof(room, args.secretHash, args.sign)),
    });
    return { token: data.member_token as string };
  }

  private readonly args: RelayClientArgs;
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCursor: number;
  private ackCursor = 0;
  private readonly pending = new Map<string, Pending>();
  private firstConnect: { resolve(): void; reject(e: Error): void } | null = null;

  constructor(args: RelayClientArgs) {
    this.args = args;
    this.lastCursor = args.cursor ?? 0;
  }

  get cursor(): number {
    return this.lastCursor;
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.firstConnect = { resolve, reject };
      this.open();
    });
  }

  send(msgId: string, payload: string): Promise<{ relay_seq: number; dup: boolean }> {
    if (this.closed) return Promise.reject(new Error('client closed'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      const existing = this.pending.get(msgId);
      if (existing) existing.waiters.push(waiter);
      else this.pending.set(msgId, { payload, waiters: [waiter] });
      if (!existing && this.ready) this.transmit(msgId, payload);
    });
  }

  ack(cursor: number): void {
    if (cursor <= this.ackCursor) return;
    this.ackCursor = cursor;
    if (this.ready) this.ws?.send(JSON.stringify({ t: 'ack', cursor }));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    this.failAll(new Error('client closed'));
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        ws.addEventListener('close', () => resolve());
        ws.close();
      });
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) for (const w of p.waiters) w.reject(err);
    this.pending.clear();
  }

  private transmit(msgId: string, payload: string): void {
    this.ws?.send(JSON.stringify({ t: 'send', msg_id: msgId, payload }));
  }

  private open(): void {
    const base = this.args.relayUrl.replace(/^http/, 'ws');
    const ws = new WebSocket(`${base}/v1/rooms/${this.args.room}/ws?token=${encodeURIComponent(this.args.token)}`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'sync', after: this.lastCursor }));
    });
    ws.addEventListener('message', (ev) => this.onFrame(ws, String(ev.data)));
    ws.addEventListener('close', () => this.onClose(ws));
  }

  private onFrame(ws: WebSocket, text: string): void {
    if (ws !== this.ws) return;
    const f = JSON.parse(text) as Record<string, unknown>;
    switch (f.t) {
      case 'msg': {
        const seq = f.relay_seq as number;
        if (seq <= this.lastCursor) return;
        this.lastCursor = seq;
        this.args.onMessage({
          relay_seq: seq,
          msg_id: f.msg_id as string,
          sender_key: f.sender_key as string,
          payload: f.payload as string,
          ts: f.ts as string,
        });
        return;
      }
      case 'synced': {
        if (f.more === true) {
          ws.send(JSON.stringify({ t: 'sync', after: this.lastCursor }));
          return;
        }
        this.ready = true;
        this.attempt = 0;
        if (this.ackCursor > 0) ws.send(JSON.stringify({ t: 'ack', cursor: this.ackCursor }));
        for (const [id, p] of this.pending) this.transmit(id, p.payload);
        const first = this.firstConnect;
        this.firstConnect = null;
        first?.resolve();
        return;
      }
      case 'sent': {
        const p = this.pending.get(f.msg_id as string);
        if (!p) return;
        this.pending.delete(f.msg_id as string);
        for (const w of p.waiters) w.resolve({ relay_seq: f.relay_seq as number, dup: f.dup as boolean });
        return;
      }
      case 'presence':
        this.args.onPresence?.({ member_key: f.member_key as string, online: f.online as boolean });
        return;
      case 'error': {
        const code = String(f.code);
        const detail = String(f.detail);
        const id = f.msg_id;
        if (typeof id === 'string') {
          const p = this.pending.get(id);
          this.pending.delete(id);
          for (const w of p?.waiters ?? []) w.reject(new RelayError(code, detail));
        }
        this.args.onError?.({ code, detail });
        return;
      }
    }
  }

  private onClose(ws: WebSocket): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.ready = false;
    if (this.closed) return;
    if (this.firstConnect) {
      const first = this.firstConnect;
      this.firstConnect = null;
      this.closed = true;
      this.failAll(new Error('connection refused'));
      first.reject(new Error('relay connection failed (bad token, unknown room, or relay down)'));
      return;
    }
    const delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** this.attempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.open();
    }, delay);
  }
}
