import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64urlEncode, generateSigningKey, sha256Hash, signBytes } from '@cma/protocol';
import { RelayClient, RelayError, RelayHttpError, startRelay, type RelayMsg } from '../src/index.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function relay(opts: Parameters<typeof startRelay>[0] = {}) {
  const r = startRelay({ port: 0, ...opts });
  cleanups.push(() => r.stop());
  return r;
}

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cma-relay-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'relay.db');
}

async function waitFor(pred: () => boolean, what = 'condition', timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const secretBytes = crypto.getRandomValues(new Uint8Array(32));
const secret = base64urlEncode(secretBytes);
const secretHash = sha256Hash(secretBytes).slice('sha256:'.length);

interface Party {
  key: string;
  token: string;
  msgs: RelayMsg[];
  presence: Array<{ member_key: string; online: boolean }>;
  errors: Array<{ code: string; detail: string }>;
  client: RelayClient;
}

function makeClient(url: string, room: string, token: string, cursor?: number): Omit<Party, 'key' | 'token'> {
  const msgs: RelayMsg[] = [];
  const presence: Party['presence'] = [];
  const errors: Party['errors'] = [];
  const client = new RelayClient({
    relayUrl: url,
    room,
    token,
    cursor,
    onMessage: (m) => msgs.push(m),
    onPresence: (p) => presence.push(p),
    onError: (e) => errors.push(e),
  });
  cleanups.push(() => client.close());
  return { msgs, presence, errors, client };
}

async function setup(url: string, ttlS = 3600) {
  const ka = generateSigningKey();
  const kb = generateSigningKey();
  const a = ka.keyId;
  const b = kb.keyId;
  const created = await RelayClient.createRoom(url, { secretHash, creatorKey: a, ttlS });
  const joined = await RelayClient.joinRoom(url, created.room, { secret, memberKey: b });
  return {
    room: created.room,
    a,
    b,
    tokenA: created.token,
    tokenB: joined.token,
    signB: (bytes: Uint8Array) => signBytes(bytes, kb.secretKey),
  };
}

async function pair(url: string) {
  const s = await setup(url);
  const A: Party = { key: s.a, token: s.tokenA, ...makeClient(url, s.room, s.tokenA) };
  const B: Party = { key: s.b, token: s.tokenB, ...makeClient(url, s.room, s.tokenB) };
  await A.client.connect();
  await B.client.connect();
  return { ...s, A, B };
}

async function joinStatus(url: string, room: string, body: unknown): Promise<number> {
  const res = await fetch(`${url}/v1/rooms/${room}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

describe('T3 relay', () => {
  test('AC1: both members receive a sent message exactly once with the same relay_seq', async () => {
    const r = relay();
    const { A, B } = await pair(r.url);
    const sent = await A.client.send('m1', 'hello');
    await waitFor(() => A.msgs.length >= 1 && B.msgs.length >= 1, 'delivery');
    await new Promise((res) => setTimeout(res, 50));
    expect(A.msgs.length).toBe(1);
    expect(B.msgs.length).toBe(1);
    expect(A.msgs[0]!.relay_seq).toBe(sent.relay_seq);
    expect(B.msgs[0]!.relay_seq).toBe(sent.relay_seq);
    expect(B.msgs[0]!.payload).toBe('hello');
    expect(B.msgs[0]!.sender_key).toBe(A.key);
    expect(sent.dup).toBe(false);
  });

  test('AC2: wrong secret 403, third key 409, same key rejoin 200 with new token, unknown room 404', async () => {
    const r = relay();
    const s = await setup(r.url);
    const wrong = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const err = await RelayClient.joinRoom(r.url, s.room, { secret: wrong, memberKey: s.b }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayHttpError);
    expect(err.status).toBe(403);

    expect(await joinStatus(r.url, s.room, { secret, member_key: generateSigningKey().keyId })).toBe(409);

    const again = await RelayClient.joinRoom(r.url, s.room, { secret, memberKey: s.b, sign: s.signB });
    expect(again.token).not.toBe(s.tokenB);

    expect(await joinStatus(r.url, 'rdoesnotexist0000', { secret, member_key: s.b })).toBe(404);
  });

  test('AC2: expired room returns 410', async () => {
    let t = 1_000_000;
    const r = relay({ now: () => t });
    const s = await setup(r.url, 60);
    t += 61_000;
    expect(await joinStatus(r.url, s.room, { secret, member_key: s.b })).toBe(410);
  });

  test('AC3: no table contains the raw token or secret', async () => {
    const dbPath = tempDb();
    const r = relay({ dbPath });
    const { A, B, tokenA, tokenB } = await pair(r.url);
    await A.client.send('m1', 'hi');
    await B.client.send('m2', 'yo');
    await waitFor(() => A.msgs.length === 2, 'exchange');

    const db = new Database(dbPath, { readonly: true });
    cleanups.push(() => db.close());
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    expect(tables.length).toBeGreaterThan(0);
    const needles = [tokenA, tokenB, secret];
    let rows = 0;
    for (const { name } of tables) {
      for (const row of db.query<Record<string, unknown>, []>(`SELECT * FROM "${name}"`).all()) {
        for (const v of Object.values(row)) {
          rows++;
          for (const n of needles) expect(String(v).includes(n)).toBe(false);
        }
      }
    }
    expect(rows).toBeGreaterThan(0);
    const stored = db.query<{ secret_hash: string }, []>('SELECT secret_hash FROM rooms').get()!;
    expect(stored.secret_hash).toBe(secretHash);
  });

  test('AC4: reconnecting with a cursor receives exactly the missed messages in order, once each', async () => {
    const r = relay();
    const { A, B, room, tokenB } = await pair(r.url);
    await A.client.send('pre', 'before');
    await waitFor(() => B.msgs.length === 1, 'first delivery');
    const cursor = B.client.cursor;
    await B.client.close();

    for (let i = 1; i <= 5; i++) await A.client.send(`m${i}`, `p${i}`);

    const B2 = makeClient(r.url, room, tokenB, cursor);
    await B2.client.connect();
    await waitFor(() => B2.msgs.length >= 5, 'replay');
    await new Promise((res) => setTimeout(res, 50));
    expect(B2.msgs.map((m) => m.payload)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(B2.msgs.map((m) => m.relay_seq)).toEqual([2, 3, 4, 5, 6]);
    expect(B2.client.cursor).toBe(6);
  });

  test('AC5: duplicate msg_id returns the same relay_seq with dup true and the peer gets it once', async () => {
    const r = relay();
    const { A, B } = await pair(r.url);
    const first = await A.client.send('same', 'x');
    const second = await A.client.send('same', 'x');
    expect(second.relay_seq).toBe(first.relay_seq);
    expect(second.dup).toBe(true);
    expect(first.dup).toBe(false);
    await A.client.send('other', 'y');
    await waitFor(() => B.msgs.length >= 2, 'delivery');
    expect(B.msgs.map((m) => m.msg_id)).toEqual(['same', 'other']);
  });

  test('AC6: a send in flight when the connection drops resolves after auto-reconnect', async () => {
    const r = relay();
    const { A, B } = await pair(r.url);
    const inFlight = A.client.send('flight', 'payload');
    (A.client as unknown as { ws: WebSocket }).ws.close();
    const result = await inFlight;
    expect(result.relay_seq).toBe(1);
    await waitFor(() => B.msgs.length >= 1, 'delivery');
    expect(B.msgs.filter((m) => m.msg_id === 'flight').length).toBe(1);
  });

  test('AC7: payload over 262144 bytes is rejected with TOO_LARGE', async () => {
    const r = relay();
    const { A, B } = await pair(r.url);
    const err = await A.client.send('big', 'a'.repeat(262145)).catch((e) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err.code).toBe('TOO_LARGE');
    expect(A.errors.map((e) => e.code)).toEqual(['TOO_LARGE']);
    const ok = await A.client.send('exact', 'a'.repeat(262144));
    expect(ok.relay_seq).toBe(1);
    await waitFor(() => B.msgs.length === 1, 'delivery');
  });

  test('AC7: the 31st send within a minute is rejected with RATE_LIMITED', async () => {
    const r = relay();
    const { A } = await pair(r.url);
    for (let i = 1; i <= 30; i++) await A.client.send(`m${i}`, 'x');
    const err = await A.client.send('m31', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err.code).toBe('RATE_LIMITED');
  });

  test('AC8: presence reports the peer coming online and going offline', async () => {
    const r = relay();
    const s = await setup(r.url);
    const A: Party = { key: s.a, token: s.tokenA, ...makeClient(r.url, s.room, s.tokenA) };
    await A.client.connect();
    await waitFor(() => A.presence.some((p) => p.member_key === s.b && !p.online), 'initial offline presence');
    const B: Party = { key: s.b, token: s.tokenB, ...makeClient(r.url, s.room, s.tokenB) };
    await B.client.connect();
    await waitFor(() => A.presence.some((p) => p.member_key === s.b && p.online), 'online presence');
    await B.client.close();
    await waitFor(() => A.presence[A.presence.length - 1]!.online === false, 'offline presence');
    expect(A.presence.map((p) => p.online)).toEqual([false, true, false]);
  });

  test('AC9: websocket with a bad token is refused with HTTP 401', async () => {
    const r = relay();
    const s = await setup(r.url);
    const res = await fetch(`${r.url}/v1/rooms/${s.room}/ws?token=nope`, { headers: { upgrade: 'websocket', connection: 'Upgrade' } });
    expect(res.status).toBe(401);
    const bad = makeClient(r.url, s.room, 'nope');
    await expect(bad.client.connect()).rejects.toThrow();
  });

  test('AC10: relay_seq is strictly increasing and survives a restart on a file DB', async () => {
    const dbPath = tempDb();
    const first = startRelay({ port: 0, dbPath });
    const s = await setup(first.url);
    const A = makeClient(first.url, s.room, s.tokenA);
    await A.client.connect();
    const seqs: number[] = [];
    for (let i = 1; i <= 4; i++) seqs.push((await A.client.send(`m${i}`, `p${i}`)).relay_seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
    await A.client.close();
    await first.stop();

    const second = relay({ dbPath });
    const B = makeClient(second.url, s.room, s.tokenB);
    await B.client.connect();
    await waitFor(() => B.msgs.length === 4, 'replay after restart');
    expect(B.msgs.map((m) => m.relay_seq)).toEqual([1, 2, 3, 4]);
    const next = await B.client.send('after', 'z');
    expect(next.relay_seq).toBe(5);
  });
});
