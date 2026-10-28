import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inviteCode, verifySignoffSignature, type SignoffBody } from '../packages/protocol/src/index.ts';
import { callPaths, identityPaths, readCallRecord } from '../plugin/server/store.ts';
import { Harness, connect, freezeSimplePlan, status, waitFor, type Side } from '../plugin/test/fixtures/harness.ts';

setDefaultTimeout(30_000);

const CMA = resolve(import.meta.dir, '..', 'bin', 'cma');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function cma(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn([CMA, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cma-cli-'));
  tmpDirs.push(dir);
  return dir;
}
const harnesses: Harness[] = [];

afterAll(async () => {
  for (const h of harnesses) await h.cleanup();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const mode = (path: string): number => statSync(path).mode & 0o777;

test('AC1: keygen twice keeps the same keys and every secret file is mode 0600', async () => {
  const home = tmp();
  const first = await cma(['--home', home, 'keygen', '--human', 'alice@orders.example']);
  expect(first.code).toBe(0);
  const ids = identityPaths(home);
  const before = [ids.agentKey, ids.humanKey, ids.humanPub].map((p) => readFileSync(p, 'utf8'));
  const second = await cma(['keygen', '--home', home]);
  expect(second.code).toBe(0);
  expect([ids.agentKey, ids.humanKey, ids.humanPub].map((p) => readFileSync(p, 'utf8'))).toEqual(before);
  expect(second.stdout).toBe(first.stdout);
  expect(first.stdout).toContain(before[2]!.trim());
  expect(mode(ids.agentKey)).toBe(0o600);
  expect(mode(ids.humanKey)).toBe(0o600);
  expect(JSON.parse(readFileSync(ids.profile, 'utf8')).human).toBe('alice@orders.example');
});

describe('calls driven through the plugin managers', () => {
  let h: Harness;
  let alice: Side;
  let bob: Side;
  let discussing: string;
  let frozen: string;
  let agreement: string;

  beforeAll(async () => {
    h = new Harness();
    harnesses.push(h);
    alice = await h.side('alice');
    bob = await h.side('bob');
    discussing = (await connect(alice, bob, 'Still talking')).session;
    frozen = (await connect(alice, bob, 'Order list API for billing')).session;
    await freezeSimplePlan(alice, bob, frozen);
  });

  const mdPrefix = (side: Side, session: string): string => {
    const hash = side.manager.planGet({ session, format: 'markdown' }).md_hash as string;
    return hash.replace(/^sha256:/, '').slice(0, 6);
  };

  test('AC2: approve on a call that is not FROZEN exits 1 and names the state', async () => {
    const run = await cma(['--home', alice.home, 'approve', discussing, '--yes-i-read-it', '000000']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('DISCUSSING');
    expect(existsSync(callPaths(alice.home, discussing).signoff)).toBe(false);
  });

  test('AC5: approve without a TTY and without --yes-i-read-it exits 1 and writes nothing', async () => {
    const run = await cma(['--home', alice.home, 'approve', frozen]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('--yes-i-read-it');
    expect(existsSync(callPaths(alice.home, frozen).signoff)).toBe(false);
  });

  test('AC3: approve with the wrong 6 hex chars exits 1 and writes nothing', async () => {
    const right = mdPrefix(alice, frozen);
    const wrong = right === '000000' ? '111111' : '000000';
    const run = await cma(['--home', alice.home, 'approve', frozen, '--yes-i-read-it', wrong]);
    expect(run.code).toBe(1);
    expect(existsSync(callPaths(alice.home, frozen).signoff)).toBe(false);
  });

  test('AC3: approve by CMA code with the right chars writes a signoff the plugin accepts, and both signoffs close the call', async () => {
    const code = inviteCode(readCallRecord(alice.home, frozen).room);
    const a = await cma(['--home', alice.home, 'approve', code, '--yes-i-read-it', mdPrefix(alice, frozen)]);
    expect(a.code).toBe(0);
    expect(a.stdout).toContain('md hash');
    const body = JSON.parse(readFileSync(callPaths(alice.home, frozen).signoff, 'utf8')) as SignoffBody;
    expect(verifySignoffSignature(body)).toBe(true);
    expect(body.statement.decision).toBe('approve');
    expect(body.statement.human).toBe('alice@orders.example');
    expect(existsSync(`${callPaths(alice.home, frozen).signoff}.tmp`)).toBe(false);

    const b = await cma(['--home', bob.home, 'approve', frozen, '--yes-i-read-it', mdPrefix(bob, frozen).toUpperCase()]);
    expect(b.code).toBe(0);
    await waitFor(() => status(alice, frozen).final === true && status(bob, frozen).final === true, 'plan_final on both sides');
    const written = await alice.manager.writePlan({ session: frozen });
    agreement = readFileSync(written.path as string, 'utf8');
    expect(existsSync(callPaths(alice.home, frozen).signoffRejected)).toBe(false);
  });

  test('calls lists code, peer, state and version', async () => {
    const run = await cma(['--home', alice.home, 'calls']);
    expect(run.code).toBe(0);
    const line = run.stdout.split('\n').find((l) => l.includes(frozen))!;
    expect(line).toContain(inviteCode(readCallRecord(alice.home, frozen).room));
    expect(line).toContain('bob@billing.example');
    expect(line).toMatch(/\b1\b/);
    expect(run.stdout.split('\n').find((l) => l.includes(discussing))).toContain('DISCUSSING');
  });

  describe('verify', () => {
    const verifyText = async (text: string, extra: string[] = []): Promise<Run> => {
      const file = join(tmp(), 'agreement.md');
      writeFileSync(file, text);
      return cma(['verify', file, ...extra]);
    };
    const keys = (): { A: string; B: string } => {
      const fm = (party: string): string => new RegExp(`  ${party}:\\n    human: .*\\n    agent_key: .*\\n    human_key: "([^"]+)"`).exec(agreement)![1]!;
      return { A: fm('A'), B: fm('B') };
    };

    test('AC4: verify on a valid agreement file exits 0 and prints both signers', async () => {
      const run = await verifyText(agreement);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain('alice@orders.example');
      expect(run.stdout).toContain('bob@billing.example');
    });

    test('AC4: a flipped character in the body, the embedded JSON and a signature each exit 1 with distinct reasons', async () => {
      const bodyAt = agreement.indexOf('Still') >= 0 ? agreement.indexOf('Still') : agreement.indexOf('# ') + 2;
      const flip = (text: string, at: number): string => text.slice(0, at) + (text[at] === 'x' ? 'y' : 'x') + text.slice(at + 1);
      const jsonAt = agreement.indexOf('<!-- cma-plan\n') + '<!-- cma-plan\n'.length + 20;
      const sigAt = agreement.indexOf('sig: "') + 'sig: "'.length + 3;
      const reasons = new Set<string>();
      for (const at of [bodyAt, jsonAt, sigAt]) {
        const run = await verifyText(flip(agreement, at));
        expect(run.code).toBe(1);
        reasons.add(run.stderr.trim());
      }
      expect(reasons.size).toBe(3);
    });

    test('AC8: --expect A=<key> --expect B=<key> passes for the signers and exits 1 for another key', async () => {
      const { A, B } = keys();
      expect((await verifyText(agreement, ['--expect', `A=${A}`, '--expect', `B=${B}`])).code).toBe(0);
      const swapped = await verifyText(agreement, ['--expect', `A=${B}`, '--expect', `B=${B}`]);
      expect(swapped.code).toBe(1);
      expect(swapped.stderr).toContain('party A');
    });
  });
});

describe('session', () => {
  test('AC7: session --home writes a settings file denying Read of the CMA root plus every base-profile deny rule', async () => {
    const home = tmp();
    const dir = tmp();
    const run = await cma(['session', dir, '--home', home]);
    expect(run.code).toBe(0);
    const settingsPath = join(home, 'session-settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { permissions: { deny: string[]; allow: string[] } };
    const base = JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'plugin', 'profiles', 'call.json'), 'utf8')) as typeof settings;
    expect(settings.permissions.deny).toContain(`Read(/${home}/**)`);
    for (const rule of base.permissions.deny) expect(settings.permissions.deny).toContain(rule);
    expect(settings.permissions.allow).toEqual(base.permissions.allow);
    expect(run.stdout).toContain(`--settings ${settingsPath}`);
    expect(run.stdout).toContain('--plugin-dir');
    expect(run.stdout).toContain(`CMA_HOME=${home}`);
  });

  test('session --exec refuses --dangerously-skip-permissions and --permission-mode', async () => {
    const home = tmp();
    for (const flag of [['--dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'], ['--permission-mode=acceptEdits']]) {
      const run = await cma(['session', '--exec', '--home', home, '--', ...flag]);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('refusing');
    }
  });
});
