import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  createSignoff,
  fingerprint,
  hexToBytes,
  inviteCode,
  markdownHash,
  renderMarkdown,
  replay,
  verifyAgreementFile,
  type Envelope,
  type Party,
} from '@cma/protocol';
import { startRelay } from '@cma/relay';
import {
  callPaths,
  identityPaths,
  listSessions,
  loadOrCreateIdentity,
  readCallRecord,
  readLog,
  resolveRoot,
  type CallRecord,
} from '../plugin/server/store.ts';

const PLUGIN_DIR = resolve(import.meta.dir, '..', 'plugin');
const BASE_PROFILE = join(PLUGIN_DIR, 'profiles', 'call.json');

const USAGE = `usage: cma [--home <dir>] <command>
  keygen [--human <email>]
  approve <session|CMA-code> [--decline] [--yes-i-read-it <6 hex>]
  verify <file.md> [--expect A=<key>] [--expect B=<key>]
  relay [--port 8787] [--db path] [--host 127.0.0.1]
  session [dir] [--exec] [--from <last|pick|session-id>] [-- <claude args>]
  calls
  invite <session|CMA-code>
  log <session|CMA-code> [--json]`;

class CliError extends Error {}

const out = (text: string): void => void process.stdout.write(`${text}\n`);
const err = (text: string): void => void process.stderr.write(`${text}\n`);

function fail(message: string): never {
  throw new CliError(message);
}

function findCall(root: string, ref: string): CallRecord {
  const sessions = listSessions(root);
  if (sessions.includes(ref)) return readCallRecord(root, ref);
  const wanted = ref.toUpperCase();
  for (const session of sessions) {
    const record = readCallRecord(root, session);
    if (inviteCode(record.room) === wanted) return record;
  }
  return fail(`no call matches ${JSON.stringify(ref)} under ${root}`);
}

function keygen(root: string, args: string[]): number {
  const { values } = parseArgs({ args, options: { human: { type: 'string' } } });
  const identity = loadOrCreateIdentity(root, values.human ? { human: values.human } : {});
  out(`human   ${identity.profile.human}`);
  out(`agent   ${identity.agent.keyId}  ${fingerprint(identity.agent.keyId)}`);
  out(`human   ${identity.humanKey}  ${fingerprint(identity.humanKey)}`);
  out(`keys in ${identityPaths(root).dir}`);
  return 0;
}

async function readTypedLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

async function approve(root: string, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { decline: { type: 'boolean' }, 'yes-i-read-it': { type: 'string' } },
  });
  const ref = positionals[0];
  if (!ref) fail('usage: cma approve <session|CMA-code> [--decline] [--yes-i-read-it <6 hex>]');
  const record = findCall(root, ref);
  const session = record.session;
  const r = replay(readLog(root, session));
  if (r.state !== 'FROZEN' || !r.frozen || !r.plan || !r.charter || !r.charterHash) {
    fail(`call ${session} is ${r.state}, not FROZEN; there is nothing to approve`);
  }
  const identity = loadOrCreateIdentity(root);
  const me = r.identities[record.party];
  if (!me || me.human_key !== identity.humanKey) {
    fail(`identity/human.pub does not match the human key this call was opened with (${me?.human_key ?? 'unknown'})`);
  }
  const mdHash = markdownHash(r.plan);
  if (mdHash !== r.frozen.mdHash) fail('rendered plan does not match the frozen md_hash');
  const expected = mdHash.replace(/^sha256:/, '').slice(0, 6);

  out(renderMarkdown(r.plan));
  out('---');
  out(`session   ${session}`);
  out(`you are   ${record.party} (${identity.profile.human})`);
  out(`version   ${r.frozen.version}`);
  out(`plan hash ${r.frozen.hash}`);
  out(`md hash   ${mdHash}`);

  const decision = values.decline ? 'decline' : 'approve';
  let typed = values['yes-i-read-it'];
  if (typed === undefined) {
    if (!process.stdin.isTTY) fail('stdin is not a terminal; pass --yes-i-read-it <first 6 hex of the md hash>');
    typed = await readTypedLine(`To ${decision}, type the first 6 hex characters of the md hash (${expected}): `);
  }
  if (typed.toLowerCase() !== expected) fail('the characters do not match the md hash; nothing was signed');

  const body = createSignoff({
    session,
    charterHash: r.charterHash,
    mode: r.charter.mode,
    party: record.party,
    human: identity.profile.human,
    frozen: r.frozen,
    decision,
    humanSecretKey: hexToBytes(readFileSync(identityPaths(root).humanKey, 'utf8').trim()),
    ts: new Date().toISOString(),
  });
  const target = callPaths(root, session).signoff;
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
  out(`${decision === 'approve' ? 'approved' : 'declined'}: wrote ${target}`);
  return 0;
}

function verify(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { expect: { type: 'string', multiple: true } },
  });
  const file = positionals[0];
  if (!file) fail('usage: cma verify <file.md> [--expect A=<key>] [--expect B=<key>]');
  const expect: Partial<Record<Party, string>> = {};
  for (const item of values.expect ?? []) {
    const m = /^([AB])=(.+)$/.exec(item);
    if (!m) fail(`--expect must look like A=<key>, got ${JSON.stringify(item)}`);
    expect[m[1] as Party] = m[2]!;
  }
  const verdict = verifyAgreementFile(readFileSync(file, 'utf8'));
  if (!verdict.ok) fail(`INVALID: ${verdict.reason}`);
  for (const party of ['A', 'B'] as const) {
    const want = expect[party];
    if (want !== undefined && verdict.signers[party].human_key !== want) {
      fail(`INVALID: human key of party ${party} is ${verdict.signers[party].human_key}, expected ${want}`);
    }
  }
  out(`OK plan_hash ${verdict.planHash}`);
  for (const party of ['A', 'B'] as const) {
    const s = verdict.signers[party];
    out(`${party}: ${s.human}  ${s.human_key}  signed ${s.signed_at}`);
  }
  return 0;
}

async function relay(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { port: { type: 'string' }, db: { type: 'string' }, host: { type: 'string' } },
  });
  const port = Number(values.port ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid --port ${values.port}`);
  const server = startRelay({ port, hostname: values.host ?? '127.0.0.1', ...(values.db ? { dbPath: values.db } : {}) });
  out(`relay listening on ${server.url}`);
  await new Promise<void>((done) => {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => done());
  });
  await server.stop();
  return 0;
}

const FORBIDDEN_PASSTHROUGH = /^--(dangerously-skip-permissions|permission-mode)(=|$)/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function forkArgs(from: string | undefined): string[] {
  if (from === undefined) return [];
  if (from === 'last') return ['--continue', '--fork-session'];
  if (from === 'pick') return ['--resume', '--fork-session'];
  if (!UUID.test(from)) fail(`--from expects last, pick or a session id (UUID); got ${from}`);
  return ['--resume', from, '--fork-session'];
}

async function session(root: string, args: string[]): Promise<number> {
  const dashdash = args.indexOf('--');
  const own = dashdash < 0 ? args : args.slice(0, dashdash);
  const passthrough = dashdash < 0 ? [] : args.slice(dashdash + 1);
  const { values, positionals } = parseArgs({ args: own, allowPositionals: true, options: { exec: { type: 'boolean' }, from: { type: 'string' } } });
  const dir = resolve(positionals[0] ?? '.');
  if (values.exec && passthrough.some((a) => FORBIDDEN_PASSTHROUGH.test(a))) {
    fail('refusing --exec with --dangerously-skip-permissions or --permission-mode');
  }
  const fork = forkArgs(values.from);
  const base = JSON.parse(readFileSync(BASE_PROFILE, 'utf8')) as { permissions: { deny: string[] } };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // `//` marks an absolute filesystem path in permission rules; the symlink-resolved root is denied too.
  const roots = new Set([resolve(root), realpathSync(root)]);
  const deny = [...base.permissions.deny, ...[...roots].map((r) => `Read(/${r}/**)`)];
  const settings = { ...base, permissions: { ...base.permissions, deny } };
  const settingsPath = join(root, 'session-settings.json');
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  chmodSync(settingsPath, 0o600);

  const argv = ['claude', '--settings', settingsPath, '--plugin-dir', PLUGIN_DIR, ...fork, ...passthrough];
  const quote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  out(`cd ${quote(dir)} && CMA_HOME=${quote(resolve(root))} CMA_CALL_SESSION=1 ${argv.map(quote).join(' ')}`);
  if (!values.exec) return 0;
  const child = spawn(argv[0]!, argv.slice(1), { cwd: dir, stdio: 'inherit', env: { ...process.env, CMA_HOME: resolve(root), CMA_CALL_SESSION: '1' } });
  return new Promise<number>((done) => {
    child.on('error', (e) => {
      err(`cma: ${e.message}`);
      done(1);
    });
    child.on('exit', (code) => done(code ?? 1));
  });
}

function calls(root: string): number {
  const rows: string[][] = [['CODE', 'PEER', 'STATE', 'VERSION', 'SESSION']];
  for (const id of listSessions(root)) {
    const record = readCallRecord(root, id);
    const r = replay(readLog(root, id));
    const peerParty: Party = record.party === 'A' ? 'B' : 'A';
    const peer = r.identities[peerParty]?.human ?? record.peer?.human ?? '-';
    rows.push([inviteCode(record.room), peer, r.state, String(r.version), id]);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  for (const row of rows) out(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd());
  return 0;
}

const short = (h: unknown): string => (typeof h === 'string' ? h.replace(/^sha256:/, '').slice(0, 8) : '-');

function describe(env: Envelope): string {
  const b = env.body as Record<string, any>;
  switch (env.type) {
    case 'say':
      return String(b.text ?? '');
    case 'propose':
    case 'amend':
    case 'counter': {
      const ops = (b.patch ?? []).filter((op: any) => op.op !== 'test').map((op: any) => `${op.op} ${op.path}`);
      const head = env.type === 'propose' ? '' : `on ${short(b.proposal)}: `;
      const reasons = (b.reasons ?? []).map((r: any) => r.text).join('; ');
      return `${head}${b.rationale ?? ''}${reasons ? `\n    reasons: ${reasons}` : ''}\n    kinds: ${(b.kinds ?? []).join(', ') || '-'}\n    changes: ${ops.join(', ') || '-'}`;
    }
    case 'accept':
      return `${short(b.proposal)} -> plan ${short(b.result_hash)}${b.checkpoint_ref ? ` (checkpoint ${short(b.checkpoint_ref)})` : ''}`;
    case 'reject':
      return `${short(b.proposal)}: ${(b.reasons ?? []).map((r: any) => r.text).join('; ')}`;
    case 'withdraw':
      return short(b.proposal);
    case 'ask_user_pending':
      return `asking own human (${b.checkpoint_id}${b.kind ? `, ${b.kind}` : ''})${b.blocks?.length ? `, blocks ${b.blocks.join(', ')}` : ''}`;
    case 'user_answer_summary':
      return `${b.checkpoint_id}: ${b.summary}`;
    case 'request_signoff':
      return `freeze v${b.version} plan ${short(b.hash)}`;
    case 'signoff':
      return `${b.statement?.decision} by ${b.statement?.human} over plan ${short(b.statement?.plan_hash)}`;
    case 'session_open':
      return `topic: ${b.charter?.topic}`;
    case 'hello':
    case 'welcome':
      return `${b.identity?.human ?? ''} ${b.identity?.agent_key ? fingerprint(b.identity.agent_key) : ''}`.trim();
    case 'plan_final':
      return `plan ${short(b.plan_hash)} signed by both`;
    case 'bye':
      return `stored ${short(b.stored)}`;
    default:
      return JSON.stringify(b);
  }
}

function log(root: string, args: string[]): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  const ref = positionals[0];
  if (!ref) fail('usage: cma log <session|CMA-code> [--json]');
  const record = findCall(root, ref);
  const entries = readLog(root, record.session);
  if (values.json) {
    for (const env of entries) out(JSON.stringify(env));
    return 0;
  }
  const r = replay(entries);
  const rejected = new Map(r.rejected.map((x) => [x.id, x.code]));
  for (const env of entries) {
    const who = `${env.from.party}${env.from.party === record.party ? ' (you)' : ''}`;
    const flag = rejected.has(env.id) ? `  [REJECTED ${rejected.get(env.id)}]` : '';
    out(`#${env.relay_seq ?? '?'} ${env.ts.slice(11, 19)} ${who} ${env.type} ${short(env.id)}${flag}`);
    out(`    ${describe(env).split('\n').join('\n')}`);
  }
  out(`state ${r.state} · plan v${r.version} · floor ${r.floor ?? '-'}`);
  return 0;
}

function invite(root: string, args: string[]): number {
  const ref = args[0];
  if (!ref) fail('usage: cma invite <session|CMA-code>');
  const record = findCall(root, ref);
  if (record.party !== 'A') fail(`call ${record.session} was joined, not started, here; only the caller holds its invite`);
  out(record.invite);
  return 0;
}

/** Removes the global `--home <dir>` / `--home=<dir>` flag (only before a `--` separator). */
function takeHome(argv: string[]): { home: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let home: string | undefined;
  const stop = argv.indexOf('--');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (stop >= 0 && i >= stop) rest.push(a);
    else if (a === '--home') home = argv[++i];
    else if (a.startsWith('--home=')) home = a.slice('--home='.length);
    else rest.push(a);
  }
  return { home, rest };
}

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  try {
    const { home, rest } = takeHome(argv);
    const [command, ...args] = rest;
    if (command === undefined || command === 'help' || command === '--help') {
      err(USAGE);
      return command === undefined ? 1 : 0;
    }
    const root = resolveRoot(home ? { ...env, CMA_HOME: resolve(home) } : env);
    switch (command) {
      case 'keygen':
        return keygen(root, args);
      case 'approve':
        return await approve(root, args);
      case 'verify':
        return verify(args);
      case 'relay':
        return await relay(args);
      case 'session':
        return await session(root, args);
      case 'calls':
        return calls(root);
      case 'invite':
        return invite(root, args);
      case 'log':
        return log(root, args);
      default:
        err(`cma: unknown command ${JSON.stringify(command)}\n${USAGE}`);
        return 1;
    }
  } catch (e) {
    err(`cma: ${(e as Error).message}`);
    return 1;
  }
}
