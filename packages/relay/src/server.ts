import { Database } from 'bun:sqlite';
import { timingSafeEqual } from 'node:crypto';
import { base64urlDecode, base64urlEncode, isKeyId, sha256Hash, verifyBytes } from '@cma/protocol';

export interface RelayOptions {
  port?: number;
  hostname?: string;
  dbPath?: string;
  now?: () => number;
}

const MAX_PAYLOAD_BYTES = 262144;
const MAX_TTL_S = 259200;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const MAX_MEMBERS = 2;
const PROOF_SKEW_MS = 5 * 60_000;
const ROOM_CREATE_LIMIT = 20;
const ROOM_MAX_MESSAGES = 2000;
const ROOM_MAX_BYTES = 50 * 1024 * 1024;
const SYNC_PAGE = 500;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

interface WsData {
  room: string;
  memberKey: string;
  synced: boolean;
}
type Socket = Bun.ServerWebSocket<WsData>;

interface RoomRow {
  room: string;
  secret_hash: string;
  expires_at: number;
}
interface MemberRow {
  member_key: string;
  token_hash: string;
  ack_cursor: number;
}
interface MessageRow {
  relay_seq: number;
  msg_id: string;
  sender_key: string;
  payload: string;
  ts: string;
}

const hashToken = (token: string): string => sha256Hash(token);

function randomRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return 'r' + Array.from(bytes, (b) => BASE32[b % 32]).join('');
}

function randomToken(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function verifyResumeProof(room: string, memberKey: string, ts: unknown, proof: unknown, nowMs: number): boolean {
  if (typeof ts !== 'string' || typeof proof !== 'string') return false;
  const t = Date.parse(ts);
  if (!Number.isFinite(t) || Math.abs(nowMs - t) > PROOF_SKEW_MS) return false;
  return verifyBytes(new TextEncoder().encode(`cma-relay-resume|${room}|${ts}`), proof, memberKey);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function startRelay(opts: RelayOptions = {}): { url: string; port: number; stop(): Promise<void> } {
  const now = opts.now ?? Date.now;
  const db = new Database(opts.dbPath ?? ':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      room TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      room TEXT NOT NULL,
      member_key TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      ack_cursor INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room, member_key)
    );
    CREATE INDEX IF NOT EXISTS members_token ON members (token_hash);
    CREATE TABLE IF NOT EXISTS messages (
      room TEXT NOT NULL,
      relay_seq INTEGER NOT NULL,
      msg_id TEXT NOT NULL,
      sender_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      ts TEXT NOT NULL,
      PRIMARY KEY (room, relay_seq),
      UNIQUE (room, msg_id)
    );
  `);

  const getRoom = db.query<RoomRow, [string]>('SELECT room, secret_hash, expires_at FROM rooms WHERE room = ?');
  const insertRoom = db.query('INSERT INTO rooms (room, secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?)');
  const getMembers = db.query<MemberRow, [string]>('SELECT member_key, token_hash, ack_cursor FROM members WHERE room = ?');
  const upsertMember = db.query(
    `INSERT INTO members (room, member_key, token_hash) VALUES (?, ?, ?)
     ON CONFLICT (room, member_key) DO UPDATE SET token_hash = excluded.token_hash`,
  );
  const findByToken = db.query<{ member_key: string }, [string, string]>(
    'SELECT member_key FROM members WHERE room = ? AND token_hash = ?',
  );
  const setAck = db.query('UPDATE members SET ack_cursor = MAX(ack_cursor, ?) WHERE room = ? AND member_key = ?');
  const findMsgById = db.query<{ relay_seq: number }, [string, string]>(
    'SELECT relay_seq FROM messages WHERE room = ? AND msg_id = ?',
  );
  const insertMsg = db.query(
    `INSERT INTO messages (room, relay_seq, msg_id, sender_key, payload, ts)
     VALUES (?, (SELECT COALESCE(MAX(relay_seq), 0) + 1 FROM messages WHERE room = ?), ?, ?, ?, ?)`,
  );
  const msgByIdFull = db.query<MessageRow, [string, string]>(
    'SELECT relay_seq, msg_id, sender_key, payload, ts FROM messages WHERE room = ? AND msg_id = ?',
  );
  const msgsAfter = db.query<MessageRow, [string, number, number]>(
    'SELECT relay_seq, msg_id, sender_key, payload, ts FROM messages WHERE room = ? AND relay_seq > ? ORDER BY relay_seq LIMIT ?',
  );
  const roomUsage = db.query<{ n: number; bytes: number }, [string]>(
    'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS bytes FROM messages WHERE room = ?',
  );
  const headSeq = db.query<{ head: number }, [string]>(
    'SELECT COALESCE(MAX(relay_seq), 0) AS head FROM messages WHERE room = ?',
  );

  const purgeExpired = db.transaction((cutoff: number) => {
    const rows = db.query<{ room: string }, [number]>('SELECT room FROM rooms WHERE expires_at < ?').all(cutoff);
    for (const { room } of rows) {
      db.query('DELETE FROM messages WHERE room = ?').run(room);
      db.query('DELETE FROM members WHERE room = ?').run(room);
      db.query('DELETE FROM rooms WHERE room = ?').run(room);
    }
  });
  purgeExpired(now() - 7 * 24 * 3600 * 1000);

  const sockets = new Map<string, Set<Socket>>();
  const sendTimes = new Map<string, number[]>();
  const createTimes = new Map<string, number[]>();
  let lastSweep = now();

  const sweepRateMaps = (t: number): void => {
    if (t - lastSweep < RATE_WINDOW_MS) return;
    lastSweep = t;
    for (const map of [sendTimes, createTimes]) {
      for (const [k, v] of map) if (v.every((x) => t - x >= RATE_WINDOW_MS)) map.delete(k);
    }
  };

  const isOnline = (room: string, key: string): boolean => {
    for (const s of sockets.get(room) ?? []) if (s.data.memberKey === key) return true;
    return false;
  };

  const sendFrame = (ws: Socket, frame: unknown): void => {
    ws.send(JSON.stringify(frame));
  };

  const sendError = (ws: Socket, code: string, detail: string, msgId?: string): void => {
    sendFrame(ws, msgId === undefined ? { t: 'error', code, detail } : { t: 'error', code, detail, msg_id: msgId });
  };

  const readJson = async (req: Request): Promise<Record<string, unknown> | null> => {
    try {
      const body: unknown = await req.json();
      return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  async function createRoom(req: Request, srv: Bun.Server<WsData>): Promise<Response> {
    const t = now();
    sweepRateMaps(t);
    const ip = srv.requestIP(req)?.address ?? 'unknown';
    const recent = (createTimes.get(ip) ?? []).filter((x) => t - x < RATE_WINDOW_MS);
    if (recent.length >= ROOM_CREATE_LIMIT) {
      createTimes.set(ip, recent);
      return json(429, { error: 'too many rooms created' });
    }
    const body = await readJson(req);
    if (!body) return json(400, { error: 'bad body' });
    const { secret_hash, creator_key, ttl_s } = body;
    if (typeof secret_hash !== 'string' || !/^[0-9a-f]{64}$/.test(secret_hash)) return json(400, { error: 'bad secret_hash' });
    if (!isKeyId(creator_key)) return json(400, { error: 'bad creator_key' });
    if (typeof ttl_s !== 'number' || !Number.isInteger(ttl_s) || ttl_s < 1 || ttl_s > MAX_TTL_S) {
      return json(400, { error: 'bad ttl_s' });
    }
    const room = randomRoomId();
    const token = randomToken();
    recent.push(t);
    createTimes.set(ip, recent);
    db.transaction(() => {
      insertRoom.run(room, secret_hash, t, t + ttl_s * 1000);
      upsertMember.run(room, creator_key, hashToken(token));
    })();
    return json(201, { room, creator_token: token });
  }

  async function joinRoom(req: Request, room: string): Promise<Response> {
    const body = await readJson(req);
    if (!body) return json(400, { error: 'bad body' });
    const { secret, member_key, ts, proof } = body;
    if (typeof secret !== 'string' || !isKeyId(member_key)) return json(400, { error: 'bad body' });
    const row = getRoom.get(room);
    if (!row) return json(404, { error: 'unknown room' });
    if (now() >= row.expires_at) return json(410, { error: 'expired' });
    const presented = sha256Hash(base64urlDecode(secret)).slice('sha256:'.length);
    if (!safeEqual(presented, row.secret_hash)) return json(403, { error: 'wrong secret' });
    const members = getMembers.all(room);
    if (members.length >= MAX_MEMBERS && !members.some((m) => m.member_key === member_key)) {
      return json(409, { error: 'room full' });
    }
    if (members.some((m) => m.member_key === member_key) && !verifyResumeProof(room, member_key, ts, proof, now())) {
      return json(403, { error: 'resume proof required' });
    }
    const token = randomToken();
    upsertMember.run(room, member_key, hashToken(token));
    return json(200, { member_token: token });
  }

  async function resumeRoom(req: Request, room: string): Promise<Response> {
    const body = await readJson(req);
    if (!body) return json(400, { error: 'bad body' });
    const { member_key, ts, proof } = body;
    if (!isKeyId(member_key)) return json(400, { error: 'bad body' });
    const row = getRoom.get(room);
    if (!row) return json(404, { error: 'unknown room' });
    if (now() >= row.expires_at) return json(410, { error: 'expired' });
    const isMember = getMembers.all(room).some((m) => m.member_key === member_key);
    if (!isMember || !verifyResumeProof(room, member_key, ts, proof, now())) {
      return json(403, { error: 'resume proof required' });
    }
    const token = randomToken();
    upsertMember.run(room, member_key, hashToken(token));
    return json(200, { member_token: token });
  }

  function upgrade(req: Request, url: URL, room: string, srv: Bun.Server<WsData>): Response | undefined {
    const row = getRoom.get(room);
    if (!row) return json(404, { error: 'unknown room' });
    if (now() >= row.expires_at) return json(410, { error: 'expired' });
    const token = url.searchParams.get('token');
    const member = token ? findByToken.get(room, hashToken(token)) : null;
    if (!member) return json(401, { error: 'bad token' });
    if (srv.upgrade(req, { data: { room, memberKey: member.member_key, synced: false } })) return undefined;
    return json(400, { error: 'upgrade failed' });
  }

  function onSend(ws: Socket, frame: Record<string, unknown>): void {
    const { room, memberKey } = ws.data;
    const msgId = frame.msg_id;
    const payload = frame.payload;
    if (typeof msgId !== 'string' || msgId === '' || typeof payload !== 'string') {
      return sendError(ws, 'BAD_FRAME', 'send needs string msg_id and payload');
    }
    const roomRow = getRoom.get(room);
    if (!roomRow || now() >= roomRow.expires_at) return sendError(ws, 'EXPIRED', 'room expired', msgId);
    if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
      return sendError(ws, 'TOO_LARGE', `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`, msgId);
    }
    sweepRateMaps(now());
    const rateKey = `${room}\u0000${memberKey}`;
    const t = now();
    const recent = (sendTimes.get(rateKey) ?? []).filter((x) => t - x < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) {
      sendTimes.set(rateKey, recent);
      return sendError(ws, 'RATE_LIMITED', `more than ${RATE_LIMIT} sends per minute`, msgId);
    }
    recent.push(t);
    sendTimes.set(rateKey, recent);

    const existing = findMsgById.get(room, msgId);
    if (existing) {
      return sendFrame(ws, { t: 'sent', msg_id: msgId, relay_seq: existing.relay_seq, dup: true });
    }
    const usage = roomUsage.get(room)!;
    if (usage.n >= ROOM_MAX_MESSAGES || usage.bytes + Buffer.byteLength(payload) > ROOM_MAX_BYTES) {
      return sendError(ws, 'ROOM_FULL', 'room message or size cap reached', msgId);
    }
    insertMsg.run(room, room, msgId, memberKey, payload, new Date(t).toISOString());
    const stored = msgByIdFull.get(room, msgId)!;
    sendFrame(ws, { t: 'sent', msg_id: msgId, relay_seq: stored.relay_seq, dup: false });
    for (const peer of sockets.get(room) ?? []) {
      if (peer.data.synced) sendFrame(peer, { t: 'msg', ...stored });
    }
  }

  function onSync(ws: Socket, frame: Record<string, unknown>): void {
    const after = frame.after;
    if (typeof after !== 'number' || !Number.isInteger(after) || after < 0) {
      return sendError(ws, 'BAD_FRAME', 'sync needs integer after >= 0');
    }
    const { room } = ws.data;
    const rows = msgsAfter.all(room, after, SYNC_PAGE + 1);
    const more = rows.length > SYNC_PAGE;
    for (const m of rows.slice(0, SYNC_PAGE)) sendFrame(ws, { t: 'msg', ...m });
    if (!more) ws.data.synced = true;
    sendFrame(ws, { t: 'synced', head: headSeq.get(room)!.head, more });
  }

  const server = Bun.serve<WsData>({
    port: opts.port ?? 0,
    hostname: opts.hostname ?? '127.0.0.1',
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/v1/health') return json(200, { ok: true });
      if (req.method === 'POST' && path === '/v1/rooms') return createRoom(req, srv);
      const join = /^\/v1\/rooms\/([^/]+)\/join$/.exec(path);
      if (req.method === 'POST' && join) return joinRoom(req, join[1]!);
      const resume = /^\/v1\/rooms\/([^/]+)\/resume$/.exec(path);
      if (req.method === 'POST' && resume) return resumeRoom(req, resume[1]!);
      const ws = /^\/v1\/rooms\/([^/]+)\/ws$/.exec(path);
      if (req.method === 'GET' && ws) return upgrade(req, url, ws[1]!, srv);
      return json(404, { error: 'not found' });
    },
    websocket: {
      maxPayloadLength: 4 * 1024 * 1024,
      open(ws) {
        const { room, memberKey } = ws.data;
        let set = sockets.get(room);
        if (!set) sockets.set(room, (set = new Set()));
        const wasOnline = isOnline(room, memberKey);
        set.add(ws);
        const peer = getMembers.all(room).find((m) => m.member_key !== memberKey);
        if (peer) sendFrame(ws, { t: 'presence', member_key: peer.member_key, online: isOnline(room, peer.member_key) });
        if (!wasOnline) {
          for (const other of set) {
            if (other.data.memberKey !== memberKey) sendFrame(other, { t: 'presence', member_key: memberKey, online: true });
          }
        }
      },
      message(ws, raw) {
        let frame: unknown;
        try {
          frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
        } catch {
          return sendError(ws, 'BAD_FRAME', 'invalid JSON');
        }
        if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
          return sendError(ws, 'BAD_FRAME', 'frame must be an object');
        }
        const f = frame as Record<string, unknown>;
        switch (f.t) {
          case 'send':
            return onSend(ws, f);
          case 'sync':
            return onSync(ws, f);
          case 'ack':
            if (typeof f.cursor !== 'number' || !Number.isInteger(f.cursor) || f.cursor < 0) {
              return sendError(ws, 'BAD_FRAME', 'ack needs integer cursor >= 0');
            }
            setAck.run(f.cursor, ws.data.room, ws.data.memberKey);
            return;
          default:
            return sendError(ws, 'BAD_FRAME', 'unknown frame type');
        }
      },
      close(ws) {
        const { room, memberKey } = ws.data;
        const set = sockets.get(room);
        if (!set) return;
        set.delete(ws);
        if (set.size === 0) sockets.delete(room);
        if (!isOnline(room, memberKey)) {
          for (const other of set) {
            if (other.data.memberKey !== memberKey) sendFrame(other, { t: 'presence', member_key: memberKey, online: false });
          }
        }
      },
    },
  });

  return {
    url: `http://${server.hostname}:${server.port}`,
    port: server.port as number,
    async stop() {
      await server.stop(true);
      db.close();
    },
  };
}
