import { existsSync, readFileSync, statSync } from 'node:fs';
import { inviteCode, replay, type SessionState } from '@cma/protocol';
import { callPaths, identityPaths, listSessions, readCallRecord, readLog } from '../plugin/server/store.ts';

export const MIN_BUN = '1.3.0';
export const MIN_CLAUDE = '2.1.224';
export const DEFAULT_RELAY = 'http://127.0.0.1:8787';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

type Semver = [number, number, number];

/** First `x.y.z` found in `text`. */
export function parseSemver(text: string): Semver | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function semverAtLeast(have: Semver, want: Semver): boolean {
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== want[i]!) return have[i]! > want[i]!;
  }
  return true;
}

const MIN_BUN_PARTS = parseSemver(MIN_BUN)!;
const MIN_CLAUDE_PARTS = parseSemver(MIN_CLAUDE)!;

export function checkBun(version: string): CheckResult {
  const have = parseSemver(version);
  const ok = have !== null && semverAtLeast(have, MIN_BUN_PARTS);
  return {
    name: 'bun',
    status: ok ? 'ok' : 'fail',
    detail: `bun ${version}`,
    ...(ok ? {} : { hint: `install Bun ${MIN_BUN}+ (bun upgrade)` }),
  };
}

export async function checkClaude(env: Record<string, string | undefined>): Promise<CheckResult> {
  const path = Bun.which('claude', { PATH: env.PATH ?? '' });
  if (!path) return { name: 'claude', status: 'fail', detail: 'claude not found on PATH', hint: 'install Claude Code and make sure `claude` is on PATH' };
  try {
    const proc = Bun.spawn([path, '--version'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...env } as Record<string, string> });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const have = parseSemver(stdout);
    if (!have) return { name: 'claude', status: 'fail', detail: `could not read a version from \`claude --version\` (${path})`, hint: 'reinstall Claude Code' };
    const ok = semverAtLeast(have, MIN_CLAUDE_PARTS);
    return {
      name: 'claude',
      status: ok ? 'ok' : 'fail',
      detail: `claude ${have.join('.')} (${path})`,
      ...(ok ? {} : { hint: `Claude Code ${MIN_CLAUDE}+ is required; run \`claude update\`` }),
    };
  } catch (e) {
    return { name: 'claude', status: 'fail', detail: `could not run ${path}: ${(e as Error).message}`, hint: 'reinstall Claude Code' };
  }
}

export function checkIdentity(root: string): CheckResult {
  const p = identityPaths(root);
  const problems: string[] = [];
  for (const file of [p.agentKey, p.humanKey, p.humanPub, p.profile]) {
    if (!existsSync(file)) problems.push(`${file} is missing`);
  }
  if (problems.length > 0) return { name: 'identity', status: 'fail', detail: problems.join('; '), hint: 'run `cma keygen --human you@example.com`' };
  for (const file of [p.agentKey, p.humanKey]) {
    const mode = statSync(file).mode & 0o777;
    if (mode !== 0o600) problems.push(`${file} has mode ${mode.toString(8)}, want 600`);
  }
  for (const dir of [root, p.dir]) {
    const mode = statSync(dir).mode & 0o777;
    if (mode !== 0o700) problems.push(`${dir} has mode ${mode.toString(8)}, want 700`);
  }
  if (problems.length > 0) {
    return { name: 'identity', status: 'fail', detail: problems.join('; '), hint: `chmod 700 ${root} ${p.dir}; chmod 600 ${p.agentKey} ${p.humanKey}` };
  }
  return { name: 'identity', status: 'ok', detail: `identity in ${p.dir}` };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function checkRelayScheme(url: string): CheckResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { name: 'relay url', status: 'fail', detail: `${url} is not a URL`, hint: 'pass --relay http://host:port or set CMA_RELAY_URL' };
  }
  if (parsed.protocol === 'http:' && !LOOPBACK.has(parsed.hostname)) {
    return {
      name: 'relay url',
      status: 'warn',
      detail: `${url} is plain http to a non-loopback host`,
      hint: 'use https or a private network such as Tailscale; message content is encrypted but routing metadata is not',
    };
  }
  return { name: 'relay url', status: 'ok', detail: url };
}

export async function checkRelayHealth(url: string, timeoutMs = 3000): Promise<CheckResult> {
  const hint = 'start one with `cma relay`, or check --relay / CMA_RELAY_URL';
  try {
    const res = await fetch(new URL('/v1/health', url), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { name: 'relay', status: 'fail', detail: `${url} answered HTTP ${res.status} on /v1/health`, hint };
    return { name: 'relay', status: 'ok', detail: `${url} is healthy` };
  } catch (e) {
    return { name: 'relay', status: 'fail', detail: `${url} did not answer: ${(e as Error).message}`, hint };
  }
}

export function checkProfile(path: string): CheckResult {
  try {
    JSON.parse(readFileSync(path, 'utf8'));
    return { name: 'call profile', status: 'ok', detail: path };
  } catch (e) {
    return { name: 'call profile', status: 'fail', detail: `${path} does not parse: ${(e as Error).message}`, hint: 'restore plugin/profiles/call.json from git' };
  }
}

export function formatCheck(c: CheckResult): string {
  const mark = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗';
  return `${mark} ${c.name}: ${c.detail}${c.hint && c.status !== 'ok' ? `\n    fix: ${c.hint}` : ''}`;
}

export interface DoctorOptions {
  root: string;
  relay: string;
  env: Record<string, string | undefined>;
  profilePath: string;
  bunVersion?: string;
}

export async function runDoctor(o: DoctorOptions): Promise<CheckResult[]> {
  return [
    checkBun(o.bunVersion ?? Bun.version),
    await checkClaude(o.env),
    checkIdentity(o.root),
    checkRelayScheme(o.relay),
    await checkRelayHealth(o.relay),
    checkProfile(o.profilePath),
  ];
}

const TERMINAL: ReadonlySet<SessionState> = new Set(['CLOSED', 'DECLINED', 'ABORTED', 'EXPIRED']);

/** One line for the most recently active non-terminal call, or '' when there is none. Reads local files only and never throws. */
export function statusLine(root: string): string {
  try {
    let best: { mtime: number; session: string } | null = null;
    for (const session of listSessions(root)) {
      try {
        const paths = callPaths(root, session);
        const mtime = statSync(existsSync(paths.log) ? paths.log : paths.call).mtimeMs;
        if (best && mtime <= best.mtime) continue;
        if (!TERMINAL.has(replay(readLog(root, session)).state)) best = { mtime, session };
      } catch {
        continue;
      }
    }
    if (!best) return '';
    const record = readCallRecord(root, best.session);
    const r = replay(readLog(root, best.session));
    const parts = [`☎ ${inviteCode(record.room)}`];
    if (r.state === 'FROZEN') {
      parts.push('FROZEN', 'run cma approve');
    } else {
      if (r.state !== 'DISCUSSING' && r.state !== 'PROPOSAL_PENDING') parts.push(r.state);
      parts.push(`v${r.version}`);
      if (r.floor) parts.push(`floor ${r.floor === record.party ? 'you' : 'peer'}`);
    }
    const awaiting = Object.values(r.checkpoints).filter((c) => c.party === record.party && c.answeredIn === null).length;
    if (awaiting > 0) parts.push(`${awaiting} awaiting you`);
    return parts.join(' · ');
  } catch {
    return '';
  }
}
