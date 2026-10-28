import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import {
  bytesToHex,
  generateSigningKey,
  hexToBytes,
  isKeyId,
  signingKeyFromSecret,
  type Envelope,
  type Hash,
  type Identity,
  type KeyId,
  type Party,
  type SigningKeyPair,
} from '@cma/protocol';
import { cmaRoot } from '../hooks/lib.ts';

/** CMA root (§4.1): `CMA_HOME`, else `CLAUDE_PLUGIN_DATA`, else `~/.call-my-agent`. */
export const resolveRoot = cmaRoot;

/** Session ids become directory names, so they are restricted to a path-safe alphabet. */
export const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface IdentityPaths {
  dir: string;
  agentKey: string;
  humanKey: string;
  humanPub: string;
  profile: string;
}

export function identityPaths(root: string): IdentityPaths {
  const dir = join(root, 'identity');
  return {
    dir,
    agentKey: join(dir, 'agent.key'),
    humanKey: join(dir, 'human.key'),
    humanPub: join(dir, 'human.pub'),
    profile: join(dir, 'profile.json'),
  };
}

export interface CallPaths {
  dir: string;
  call: string;
  log: string;
  audit: string;
  signoff: string;
  signoffSent: string;
  signoffRejected: string;
}

export function callPaths(root: string, session: string): CallPaths {
  if (!SESSION_ID.test(session)) throw new Error(`invalid session id: ${JSON.stringify(session)}`);
  const dir = join(root, 'calls', session);
  return {
    dir,
    call: join(dir, 'call.json'),
    log: join(dir, 'log.jsonl'),
    audit: join(dir, 'audit.jsonl'),
    signoff: join(dir, 'signoff.json'),
    signoffSent: join(dir, 'signoff.sent.json'),
    signoffRejected: join(dir, 'signoff.rejected.json'),
  };
}

export interface Profile {
  human: string;
  org?: string;
}

export interface LocalIdentity {
  agent: SigningKeyPair;
  /** Public key of the human; the matching secret stays in `human.key`, which the server never opens. */
  humanKey: KeyId;
  profile: Profile;
}

function writeSecret(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

function readProfile(path: string): Profile {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Profile>;
  if (typeof raw.human !== 'string' || raw.human.trim() === '') throw new Error(`${path}: "human" is required`);
  return { human: raw.human, ...(typeof raw.org === 'string' && raw.org !== '' ? { org: raw.org } : {}) };
}

/**
 * Loads the local identity, creating any missing part. A new human key pair is written straight to
 * `human.key` (0600) and `human.pub`; only `human.pub` is ever read back.
 */
export function loadOrCreateIdentity(root: string, defaults: Partial<Profile> = {}): LocalIdentity {
  const p = identityPaths(root);
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  if (!existsSync(p.humanPub)) {
    if (existsSync(p.humanKey)) throw new Error(`${p.humanPub} is missing; run \`cma keygen\` to restore it`);
    const human = generateSigningKey();
    writeSecret(p.humanKey, `${bytesToHex(human.secretKey)}\n`);
    writeFileSync(p.humanPub, `${human.keyId}\n`, { mode: 0o644, flag: 'wx' });
  }
  if (!existsSync(p.agentKey)) writeSecret(p.agentKey, `${bytesToHex(generateSigningKey().secretKey)}\n`);
  if (!existsSync(p.profile)) {
    const human = defaults.human?.trim() || userInfo().username;
    const profile: Profile = { human, ...(defaults.org ? { org: defaults.org } : {}) };
    writeFileSync(p.profile, `${JSON.stringify(profile)}\n`, { mode: 0o644, flag: 'wx' });
  }
  const humanKey = readFileSync(p.humanPub, 'utf8').trim();
  if (!isKeyId(humanKey)) throw new Error(`${p.humanPub} does not hold an ed25519 key id`);
  const agentHex = readFileSync(p.agentKey, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(agentHex)) throw new Error(`${p.agentKey} does not hold a 32-byte hex secret`);
  return { agent: signingKeyFromSecret(hexToBytes(agentHex)), humanKey, profile: readProfile(p.profile) };
}

/** call.json (§4.1). Holds the relay token, join secret and x25519 secret, so it is written 0600. */
export interface CallRecord {
  session: string;
  party: Party;
  relay: string;
  room: string;
  token: string;
  /** base64url join secret */
  secret: string;
  invite: string;
  charter_hash: Hash;
  /** hex */
  x25519_secret: string;
  peer?: Identity;
  /** highest relay_seq processed */
  cursor: number;
  repo_root: string;
}

export function ensureCallDir(root: string, session: string): CallPaths {
  const paths = callPaths(root, session);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  return paths;
}

function writePrivateJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function writeCallRecord(root: string, record: CallRecord): void {
  writePrivateJson(ensureCallDir(root, record.session).call, record);
}

/** The relay seat an invite inspection took, kept until the call is joined. Holds a relay token, so it is 0600. */
export interface PendingJoin {
  session: string;
  relay: string;
  room: string;
  token: string;
}

export function pendingJoinPath(root: string, session: string): string {
  if (!SESSION_ID.test(session)) throw new Error(`invalid session id: ${JSON.stringify(session)}`);
  return join(root, 'pending', `${session}.json`);
}

export function writePendingJoin(root: string, record: PendingJoin): void {
  const path = pendingJoinPath(root, record.session);
  mkdirSync(join(root, 'pending'), { recursive: true, mode: 0o700 });
  writePrivateJson(path, record);
}

export function readPendingJoin(root: string, session: string): PendingJoin | null {
  const path = pendingJoinPath(root, session);
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<PendingJoin>;
    return typeof record.relay === 'string' && typeof record.room === 'string' && typeof record.token === 'string'
      ? { session, relay: record.relay, room: record.room, token: record.token }
      : null;
  } catch {
    return null;
  }
}

export function removePendingJoin(root: string, session: string): void {
  rmSync(pendingJoinPath(root, session), { force: true });
}

export function readCallRecord(root: string, session: string): CallRecord {
  return JSON.parse(readFileSync(callPaths(root, session).call, 'utf8')) as CallRecord;
}

/** Sessions with a call.json under `<root>/calls`. */
export function listSessions(root: string): string[] {
  const dir = join(root, 'calls');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => SESSION_ID.test(name) && existsSync(join(dir, name, 'call.json')))
    .sort();
}

/** Envelopes of log.jsonl in file order; a torn last line is skipped. */
export function readLog(root: string, session: string): Envelope[] {
  const path = callPaths(root, session).log;
  if (!existsSync(path)) return [];
  const out: Envelope[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as Envelope);
    } catch {
      continue;
    }
  }
  return out;
}

export function appendLog(root: string, session: string, env: Envelope): void {
  const paths = ensureCallDir(root, session);
  appendFileSync(paths.log, `${JSON.stringify(env)}\n`, { mode: 0o600 });
}

export type AuditRecord = { kind: string } & Record<string, unknown>;

/** Appends `{ts, kind, ...}` to the call's audit.jsonl, the same shape the disclosure hook writes. */
export function appendAudit(root: string, session: string, record: AuditRecord): void {
  const paths = ensureCallDir(root, session);
  appendFileSync(paths.audit, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
}

export function readAudit(root: string, session: string): AuditRecord[] {
  const path = callPaths(root, session).audit;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AuditRecord);
}
