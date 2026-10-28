import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64urlEncode, generateSigningKey, sha256Hash, signBytes } from '@cma/protocol';
import { RelayClient, startRelay, type RelayMsg } from '../src/index.ts';

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
  const dir = mkdtempSync(join(tmpdir(), 'cma-relay-hard-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'relay.db');
}

const secretBytes = crypto.getRandomValues(new Uint8Array(32));
const secret = base64urlEncode(secretBytes);
const secretHash = sha256Hash(secretBytes).slice('sha256:'.length);

const proofBytes = (room: string, ts: string) => new TextEncoder().encode(`cma-relay-resume|${room}|${ts}`);

async function setup(url: string) {
  const ka = generateSigningKey();
  const kb = generateSigningKey();
  const created = await RelayClient.createRoom(url, { secretHash, creatorKey: ka.keyId, ttlS: 3600 });
  const joined = await RelayClient.joinRoom(url, created.room, { secret, memberKey: kb.keyId });
  return {
    room: created.room,
    ka,
    kb,
    tokenA: created.token,
    tokenB: joined.token,
    signA: (b: Uint8Array) => signBytes(b, ka.secretKey),
    signB: (b: Uint8Array) => signBytes(b, kb.secretKey),
  };
}

const wsStatus = async (url: string, room: string, token: string) =>
  (await fetch(`${url}/v1/rooms/${room}/ws?token=${encodeURIComponent(token)}`)).status;

async function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function insertMessages(dbPath: string, room: string, n: number, payload = 'x'): void {
  const db = new Database(dbPath);
  const stmt = db.query('INSERT INTO messages (room, relay_seq, msg_id, sender_key, payload, ts) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (let i = 1; i <= n; i++) stmt.run(room, i, `seed${i}`, 'ed25519:seed', payload, new Date().toISOString());
  })();
  db.close();
}

describe('T10 seat resume proofs', () => {
  test('AC1: re-joining as the creator key with only the secret is refused and the original token keeps working', async () => {
    const r = relay();
    const s = await setup(r.url);
    const res = await post(r.url, `/v1/rooms/${s.room}/join`, { secret, member_key: s.ka.keyId });
    expect(res.status).toBe(403);
    expect(await wsStatus(r.url, s.room, s.tokenA)).not.toBe(401);
  });

  test('AC2: joining with a valid proof returns a new token and invalidates the old one', async () => {
    const r = relay();
    const s = await setup(r.url);
    const fresh = await RelayClient.joinRoom(r.url, s.room, { secret, memberKey: s.kb.keyId, sign: s.signB });
    expect(fresh.token).not.toBe(s.tokenB);
    expect(await wsStatus(r.url, s.room, s.tokenB)).toBe(401);
    expect(await wsStatus(r.url, s.room, fresh.token)).not.toBe(401);
  });

  test('AC2: the creator resumes without the secret via resumeSeat', async () => {
    const r = relay();
    const s = await setup(r.url);
    const fresh = await RelayClient.resumeSeat(r.url, s.room, { memberKey: s.ka.keyId, sign: s.signA });
    expect(await wsStatus(r.url, s.room, s.tokenA)).toBe(401);
    expect(await wsStatus(r.url, s.room, fresh.token)).not.toBe(401);
  });

  test('AC2: a proof older than 5 minutes is refused with 403', async () => {
    const r = relay();
    const s = await setup(r.url);
    const ts = new Date(Date.now() - 5 * 60_000 - 5_000).toISOString();
    const proof = s.signA(proofBytes(s.room, ts));
    expect((await post(r.url, `/v1/rooms/${s.room}/resume`, { member_key: s.ka.keyId, ts, proof })).status).toBe(403);
    expect((await post(r.url, `/v1/rooms/${s.room}/join`, { secret, member_key: s.ka.keyId, ts, proof })).status).toBe(403);
    expect(await wsStatus(r.url, s.room, s.tokenA)).not.toBe(401);
  });

  test('AC2: a proof dated more than 5 minutes in the future is refused with 403', async () => {
    const r = relay();
    const s = await setup(r.url);
    const ts = new Date(Date.now() + 6 * 60_000).toISOString();
    const proof = s.signA(proofBytes(s.room, ts));
    expect((await post(r.url, `/v1/rooms/${s.room}/resume`, { member_key: s.ka.keyId, ts, proof })).status).toBe(403);
  });

  test('AC2: a proof signed by another key is refused with 403', async () => {
    const r = relay();
    const s = await setup(r.url);
    const ts = new Date().toISOString();
    const proof = s.signB(proofBytes(s.room, ts));
    expect((await post(r.url, `/v1/rooms/${s.room}/resume`, { member_key: s.ka.keyId, ts, proof })).status).toBe(403);
    expect((await post(r.url, `/v1/rooms/${s.room}/join`, { secret, member_key: s.ka.keyId, ts, proof })).status).toBe(403);
    expect(await wsStatus(r.url, s.room, s.tokenA)).not.toBe(401);
  });

  test('AC2: a proof made for a different room is refused with 403', async () => {
    const r = relay();
    const s = await setup(r.url);
    const ts = new Date().toISOString();
    const proof = s.signA(proofBytes('rotherroom', ts));
    expect((await post(r.url, `/v1/rooms/${s.room}/resume`, { member_key: s.ka.keyId, ts, proof })).status).toBe(403);
  });

  test('AC2: resume by a key that is not a member is refused with 403', async () => {
    const r = relay();
    const s = await setup(r.url);
    const outsider = generateSigningKey();
    const ts = new Date().toISOString();
    const proof = signBytes(proofBytes(s.room, ts), outsider.secretKey);
    expect((await post(r.url, `/v1/rooms/${s.room}/resume`, { member_key: outsider.keyId, ts, proof })).status).toBe(403);
  });

  test('AC2: a first join of a new key needs only the secret, even when a proof is supplied', async () => {
    const r = relay();
    const k = generateSigningKey();
    const created = await RelayClient.createRoom(r.url, { secretHash, creatorKey: generateSigningKey().keyId, ttlS: 3600 });
    const joined = await RelayClient.joinRoom(r.url, created.room, {
      secret,
      memberKey: k.keyId,
      sign: (b) => signBytes(b, k.secretKey),
    });
    expect(await wsStatus(r.url, created.room, joined.token)).not.toBe(401);
  });
});

describe('T10 abuse limits', () => {
  test('AC3: the 21st room creation within a minute from one IP is 429', async () => {
    const r = relay();
    const body = { secret_hash: 'a'.repeat(64), creator_key: generateSigningKey().keyId, ttl_s: 3600 };
    for (let i = 0; i < 20; i++) expect((await post(r.url, '/v1/rooms', body)).status).toBe(201);
    expect((await post(r.url, '/v1/rooms', body)).status).toBe(429);
  });

  test('AC3: room creation is allowed again after the window passes', async () => {
    let t = 1_000_000;
    const r = relay({ now: () => t });
    const body = { secret_hash: 'a'.repeat(64), creator_key: generateSigningKey().keyId, ttl_s: 3600 };
    for (let i = 0; i < 20; i++) await post(r.url, '/v1/rooms', body);
    expect((await post(r.url, '/v1/rooms', body)).status).toBe(429);
    t += 61_000;
    expect((await post(r.url, '/v1/rooms', body)).status).toBe(201);
  });

  test('AC3: a burst of 300 concurrent room creations is throttled to 20', async () => {
    const r = relay();
    const body = { secret_hash: 'a'.repeat(64), creator_key: generateSigningKey().keyId, ttl_s: 3600 };
    const codes = await Promise.all(Array.from({ length: 300 }, () => post(r.url, '/v1/rooms', body).then((x) => x.status)));
    expect(codes.filter((c) => c === 201).length).toBe(20);
    expect(codes.filter((c) => c === 429).length).toBe(280);
  });

  test('AC4: a send beyond 2000 stored messages is rejected with ROOM_FULL', async () => {
    const dbPath = tempDb();
    const r = relay({ dbPath });
    const s = await setup(r.url);
    insertMessages(dbPath, s.room, 2000);
    const errors: Array<{ code: string }> = [];
    const c = new RelayClient({
      relayUrl: r.url,
      room: s.room,
      token: s.tokenA,
      cursor: 2000,
      onMessage: () => {},
      onError: (e) => errors.push(e),
    });
    cleanups.push(() => c.close());
    await c.connect();
    const err = await c.send('over', 'x').catch((e) => e);
    expect(err.code).toBe('ROOM_FULL');
    expect(errors.map((e) => e.code)).toEqual(['ROOM_FULL']);
  });

  test('AC4: a send that would exceed 50 MB of stored payload is rejected with ROOM_FULL', async () => {
    const dbPath = tempDb();
    const r = relay({ dbPath });
    const s = await setup(r.url);
    const n = 208;
    insertMessages(dbPath, s.room, n, 'a'.repeat(250_000));
    const c = new RelayClient({ relayUrl: r.url, room: s.room, token: s.tokenA, cursor: n, onMessage: () => {} });
    cleanups.push(() => c.close());
    await c.connect();
    expect((await c.send('fits', 'a'.repeat(250_000))).relay_seq).toBe(n + 1);
    const err = await c.send('over', 'a'.repeat(250_000)).catch((e) => e);
    expect(err.code).toBe('ROOM_FULL');
  });

  test('AC4: sync of 1200 messages arrives in pages of 500, 500 and 200', async () => {
    const dbPath = tempDb();
    const r = relay({ dbPath });
    const s = await setup(r.url);
    insertMessages(dbPath, s.room, 1200);
    const ws = new WebSocket(`${r.url.replace(/^http/, 'ws')}/v1/rooms/${s.room}/ws?token=${s.tokenA}`);
    cleanups.push(() => ws.close());
    const pages: Array<{ msgs: number; more: boolean; head: number }> = [];
    let count = 0;
    let total = 0;
    await new Promise<void>((resolve) => {
      ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'sync', after: 0 })));
      ws.addEventListener('message', (ev) => {
        const f = JSON.parse(String(ev.data));
        if (f.t === 'msg') count++;
        if (f.t === 'synced') {
          pages.push({ msgs: count, more: f.more, head: f.head });
          total += count;
          count = 0;
          if (!f.more) return resolve();
          ws.send(JSON.stringify({ t: 'sync', after: total }));
        }
      });
    });
    expect(pages).toEqual([
      { msgs: 500, more: true, head: 1200 },
      { msgs: 500, more: true, head: 1200 },
      { msgs: 200, more: false, head: 1200 },
    ]);
  });

  test('AC4: the client ends with all 1200 messages in order', async () => {
    const dbPath = tempDb();
    const r = relay({ dbPath });
    const s = await setup(r.url);
    insertMessages(dbPath, s.room, 1200);
    const got: RelayMsg[] = [];
    const c = new RelayClient({ relayUrl: r.url, room: s.room, token: s.tokenB, onMessage: (m) => got.push(m) });
    cleanups.push(() => c.close());
    await c.connect();
    expect(got.map((m) => m.relay_seq)).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1));
    expect(c.cursor).toBe(1200);
    expect((await c.send('live', 'after-sync')).relay_seq).toBe(1201);
  });
});
