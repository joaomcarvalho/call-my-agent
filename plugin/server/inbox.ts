import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { formatInjection, type InjectionHeader } from './format.ts';
import type { AuditRecord } from './store.ts';

export interface InboxItem {
  relay_seq: number;
  line: string;
}

export interface SocketConfig {
  socket: string;
  token: string;
}

/** §4.2: the server's own env first, else `<root>/session-env.json` written by the SessionStart hook. */
export function socketConfig(root: string, env: Record<string, string | undefined>): SocketConfig | null {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
  if (socket && token) return { socket, token };
  const file = join(root, 'session-env.json');
  if (!existsSync(file)) return null;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<SocketConfig>;
    return typeof saved.socket === 'string' && typeof saved.token === 'string' && saved.socket && saved.token
      ? { socket: saved.socket, token: saved.token }
      : null;
  } catch {
    return null;
  }
}

/** Writes the auth line and one user message line, then closes. Rejects when the socket is missing or refuses. */
export function writeToSocket(config: SocketConfig, content: string, timeoutMs = 3000): Promise<void> {
  const payload =
    `${JSON.stringify({ type: 'auth', token: config.token })}\n` +
    `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
  return new Promise((resolve, reject) => {
    const sock = createConnection({ path: config.socket });
    let written = false;
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve();
    };
    // The receiver may keep the connection open after reading; once the bytes are written that counts as delivered.
    const timer = setTimeout(() => finish(written ? undefined : new Error('messaging socket timed out')), timeoutMs);
    sock.on('error', (err) => finish(err));
    sock.on('close', () => finish(written ? undefined : new Error('messaging socket closed before the message was written')));
    sock.on('connect', () => {
      sock.write(payload, (err) => {
        if (err) return finish(err);
        written = true;
        sock.end();
      });
    });
  });
}

export interface InboxOptions {
  root: string;
  env: Record<string, string | undefined>;
  /** Messages arriving within this window go out as one injection (§4.2: 1.5 s). */
  batchMs?: number;
  header(session: string): InjectionHeader | null;
  audit?(session: string, record: AuditRecord): void;
}

type Waiter = (items: InboxItem[]) => void;

const bySeq = (a: InboxItem, b: InboxItem): number => a.relay_seq - b.relay_seq;

/**
 * Per-home delivery of peer messages: a `cma_wait` in progress takes them first, else they are batched and
 * injected through the messaging socket, else they stay queued for `cma_wait` / `cma_inbox`.
 */
export class Inbox {
  private readonly queued = new Map<string, InboxItem[]>();
  private readonly batch = new Map<string, InboxItem[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly batchMs: number;
  private closed = false;

  constructor(private readonly opts: InboxOptions) {
    this.batchMs = opts.batchMs ?? 1500;
  }

  push(session: string, item: InboxItem): void {
    if (this.closed) return;
    if (this.waiters.get(session)?.size) {
      this.release(session, [...this.take(session), item].sort(bySeq));
      return;
    }
    if (!socketConfig(this.opts.root, this.opts.env)) {
      this.queued.set(session, [...(this.queued.get(session) ?? []), item]);
      return;
    }
    this.batch.set(session, [...(this.batch.get(session) ?? []), item]);
    if (!this.timers.has(session)) {
      this.timers.set(
        session,
        setTimeout(() => {
          this.timers.delete(session);
          void this.flush(session);
        }, this.batchMs),
      );
    }
  }

  /** Wakes any `wait` on the session even when there is nothing new, e.g. after the server sent a message on its own. */
  poke(session: string): void {
    if (this.waiters.get(session)?.size) this.release(session, this.take(session));
  }

  /** Queued and not-yet-injected messages, removed from the inbox. */
  take(session: string): InboxItem[] {
    const timer = this.timers.get(session);
    if (timer) clearTimeout(timer);
    this.timers.delete(session);
    const items = [...(this.queued.get(session) ?? []), ...(this.batch.get(session) ?? [])].sort(bySeq);
    this.queued.delete(session);
    this.batch.delete(session);
    return items;
  }

  pending(session: string): number {
    return (this.queued.get(session)?.length ?? 0) + (this.batch.get(session)?.length ?? 0);
  }

  /** Resolves with the next messages, or with whatever is pending (possibly nothing) after `timeoutMs` or a `poke`. */
  wait(session: string, timeoutMs: number): Promise<InboxItem[]> {
    const ready = this.take(session);
    if (ready.length > 0 || this.closed || timeoutMs <= 0) return Promise.resolve(ready);
    return new Promise((resolve) => {
      let set = this.waiters.get(session);
      if (!set) this.waiters.set(session, (set = new Set()));
      const waiter: Waiter = (items) => {
        clearTimeout(timer);
        set!.delete(waiter);
        resolve(items);
      };
      const timer = setTimeout(() => waiter(this.take(session)), timeoutMs);
      set.add(waiter);
    });
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const session of [...this.waiters.keys()]) this.release(session, []);
  }

  private release(session: string, items: InboxItem[]): void {
    for (const waiter of [...(this.waiters.get(session) ?? [])]) waiter(items);
  }

  private async flush(session: string): Promise<void> {
    const items = this.take(session);
    if (items.length === 0) return;
    const config = socketConfig(this.opts.root, this.opts.env);
    const header = this.opts.header(session);
    try {
      if (!config || !header) throw new Error(config ? 'unknown call' : 'no messaging socket configured');
      await writeToSocket(config, formatInjection(header, session, items.map((i) => i.line)));
      this.opts.audit?.(session, { kind: 'delivery', via: 'socket', count: items.length });
    } catch (err) {
      this.queued.set(session, [...items, ...(this.queued.get(session) ?? [])].sort(bySeq));
      this.opts.audit?.(session, { kind: 'delivery', via: 'queue', count: items.length, detail: (err as Error).message });
      if (this.waiters.get(session)?.size) this.release(session, this.take(session));
    }
  }
}
