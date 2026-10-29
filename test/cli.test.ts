import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inviteCode, verifySignoffSignature, type SignoffBody } from '@cma/protocol';
import { checkBun, checkProfile, checkRelayScheme } from '../bin/diagnostics.ts';
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

  test('invite prints the caller’s full invite by short code and refuses on the joining side', async () => {
    const record = readCallRecord(alice.home, frozen);
    const a = await cma(['--home', alice.home, 'invite', inviteCode(record.room)]);
    expect(a.code).toBe(0);
    expect(a.stdout.trim()).toBe(record.invite);
    expect(a.stdout.trim().startsWith('cma1.')).toBe(true);
    const b = await cma(['--home', bob.home, 'invite', frozen]);
    expect(b.code).toBe(1);
  });

  test('log prints every message in relay order with the sender and the final state', async () => {
    const run = await cma(['--home', alice.home, 'log', frozen]);
    expect(run.code).toBe(0);
    const lines = run.stdout.split('\n');
    expect(lines[0]).toMatch(/^#1 .* A \(you\) session_open /);
    expect(lines.some((l) => / B hello /.test(l))).toBe(true);
    expect(lines.some((l) => / request_signoff /.test(l))).toBe(true);
    expect(lines.at(-2)).toMatch(/^state \w+ · plan v\d+ · floor /);
    const json = await cma(['--home', alice.home, 'log', frozen, '--json']);
    expect(JSON.parse(json.stdout.split('\n')[0]!).type).toBe('session_open');
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
    expect(run.stdout).toContain(`CMA_HOME=${home} CMA_CALL_SESSION=1 claude `);
  });

  test('T11: session --exec starts claude with CMA_CALL_SESSION=1 and CMA_HOME', async () => {
    const home = tmp();
    const bin = tmp();
    const seen = join(bin, 'seen-env');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '%s %s' "$CMA_CALL_SESSION" "$CMA_HOME" > '${seen}'\n`, { mode: 0o755 });
    const run = await cma(['session', tmp(), '--exec', '--home', home], { PATH: `${bin}:${process.env.PATH ?? ''}` });
    expect(run.code).toBe(0);
    expect(readFileSync(seen, 'utf8')).toBe(`1 ${home}`);
  });

  test('session --exec refuses --dangerously-skip-permissions and --permission-mode', async () => {
    const home = tmp();
    for (const flag of [['--dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'], ['--permission-mode=acceptEdits']]) {
      const run = await cma(['session', '--exec', '--home', home, '--', ...flag]);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('refusing');
    }
  });

  const ID = '123e4567-e89b-12d3-a456-426614174000';
  for (const [from, forkArgv] of [
    ['last', '--continue --fork-session'],
    ['pick', '--resume --fork-session'],
    [ID, `--resume ${ID} --fork-session`],
  ] as const) {
    test(`session --from ${from === ID ? '<uuid>' : from} prints the fork arguments before pass-through args`, async () => {
      const run = await cma(['session', tmp(), '--home', tmp(), '--from', from, '--', '--model', 'x']);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain(` ${forkArgv} --model x`);
    });
  }

  test('session --from with an invalid id exits 1', async () => {
    const run = await cma(['session', tmp(), '--home', tmp(), '--from', 'not-a-uuid']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('--from');
  });

  test('session --from --exec spawns claude with the fork arguments', async () => {
    const bin = tmp();
    const seen = join(bin, 'seen-args');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${seen}'\n`, { mode: 0o755 });
    const run = await cma(['session', tmp(), '--exec', '--home', tmp(), '--from', ID], { PATH: `${bin}:${process.env.PATH ?? ''}` });
    expect(run.code).toBe(0);
    const args = readFileSync(seen, 'utf8').split('\n');
    expect(args.slice(args.indexOf('--resume'))).toEqual(['--resume', ID, '--fork-session', '']);
  });
});

function fakeClaude(version: string): string {
  const bin = tmp();
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
  return bin;
}

describe('doctor', () => {
  let h: Harness;
  beforeAll(() => {
    h = new Harness();
    harnesses.push(h);
  });

  const pathWith = (bin: string): string => `${bin}:${process.env.PATH ?? ''}`;

  test('doctor passes every check and exits 0 with a healthy relay, identity and claude', async () => {
    const home = tmp();
    await cma(['--home', home, 'keygen']);
    const run = await cma(['--home', home, 'doctor', '--relay', h.relay.url], { PATH: pathWith(fakeClaude('2.1.224')) });
    expect(run.stdout).not.toContain('✗');
    expect(run.stdout).toContain('✓ claude: claude 2.1.224');
    expect(run.stdout).toContain('✓ relay');
    expect(run.code).toBe(0);
  });

  test('doctor reads the relay from CMA_RELAY_URL when --relay is absent', async () => {
    const home = tmp();
    await cma(['--home', home, 'keygen']);
    const run = await cma(['--home', home, 'doctor'], { PATH: pathWith(fakeClaude('2.2.0')), CMA_RELAY_URL: h.relay.url });
    expect(run.stdout).toContain(`${h.relay.url} is healthy`);
    expect(run.code).toBe(0);
  });

  test('doctor fails with a fix hint when claude is older than 2.1.224', async () => {
    const home = tmp();
    await cma(['--home', home, 'keygen']);
    const run = await cma(['--home', home, 'doctor', '--relay', h.relay.url], { PATH: pathWith(fakeClaude('2.1.223')) });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('✗ claude: claude 2.1.223');
    expect(run.stdout).toContain('fix: Claude Code 2.1.224+');
  });

  test('doctor fails when claude is not on PATH', async () => {
    const home = tmp();
    await cma(['--home', home, 'keygen']);
    const bin = tmp();
    symlinkSync(process.execPath, join(bin, 'bun'));
    const run = await cma(['--home', home, 'doctor', '--relay', h.relay.url], { PATH: bin });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('✗ claude: claude not found on PATH');
  });

  test('doctor fails when there is no identity and names cma keygen', async () => {
    const run = await cma(['--home', tmp(), 'doctor', '--relay', h.relay.url], { PATH: pathWith(fakeClaude('2.1.224')) });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('✗ identity');
    expect(run.stdout).toContain('cma keygen');
  });

  test('doctor fails when a key file is group-readable', async () => {
    const home = tmp();
    await cma(['--home', home, 'keygen']);
    chmodSync(identityPaths(home).humanKey, 0o644);
    const run = await cma(['--home', home, 'doctor', '--relay', h.relay.url], { PATH: pathWith(fakeClaude('2.1.224')) });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('has mode 644, want 600');
  });

  test('doctor fails when the relay does not answer', async () => {
    const home = tmp();
    await cma(['--home', home, 'keygen']);
    const run = await cma(['--home', home, 'doctor', '--relay', 'http://127.0.0.1:1'], { PATH: pathWith(fakeClaude('2.1.224')) });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('✗ relay');
    expect(run.stdout).toContain('cma relay');
  });

  test('doctor warns without failing for a non-loopback http relay', () => {
    expect(checkRelayScheme('http://relay.example:8787').status).toBe('warn');
    expect(checkRelayScheme('https://relay.example').status).toBe('ok');
    expect(checkRelayScheme('http://localhost:8787').status).toBe('ok');
    expect(checkRelayScheme('http://127.0.0.1:8787').status).toBe('ok');
  });

  test('checkProfile fails on a profile that is not JSON', () => {
    const file = join(tmp(), 'call.json');
    writeFileSync(file, '{ nope');
    expect(checkProfile(file).status).toBe('fail');
    expect(checkProfile(resolve(import.meta.dir, '..', 'plugin', 'profiles', 'call.json')).status).toBe('ok');
  });

  test('checkBun rejects versions below 1.3', () => {
    expect(checkBun('1.2.9').status).toBe('fail');
    expect(checkBun('1.3.0').status).toBe('ok');
    expect(checkBun('2.0.1').status).toBe('ok');
  });
});

describe('statusline', () => {
  test('statusline prints nothing and exits 0 when there are no calls', async () => {
    const run = await cma(['--home', tmp(), 'statusline']);
    expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  test('statusline shows the code, version, floor and unanswered checkpoints of an active call', async () => {
    const h = new Harness();
    harnesses.push(h);
    const alice = await h.side('alice');
    const bob = await h.side('bob');
    const { session } = await connect(alice, bob, 'Statusline topic');
    await alice.manager.checkpoint({ session, question: 'Rename the field?', kind: 'breaking_change' });
    const code = inviteCode(readCallRecord(alice.home, session).room);
    const run = await cma(['--home', alice.home, 'statusline']);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toMatch(new RegExp(`^☎ ${code} · v\\d+ · floor (you|peer) · 1 awaiting you$`));
    const peer = await cma(['--home', bob.home, 'statusline']);
    expect(peer.stdout).toContain(`☎ ${code}`);
    expect(peer.stdout).not.toContain('awaiting you');
  });

  test('statusline says FROZEN and points at cma approve once the plan is frozen', async () => {
    const h = new Harness();
    harnesses.push(h);
    const alice = await h.side('alice');
    const bob = await h.side('bob');
    const { session } = await connect(alice, bob, 'Frozen statusline');
    await freezeSimplePlan(alice, bob, session);
    const run = await cma(['--home', alice.home, 'statusline']);
    expect(run.stdout.trim()).toBe(`☎ ${inviteCode(readCallRecord(alice.home, session).room)} · FROZEN · run cma approve`);
  });

  test('statusline prints nothing and exits 0 for a corrupt call', async () => {
    const home = tmp();
    mkdirSync(join(home, 'calls', 'broken'), { recursive: true });
    writeFileSync(join(home, 'calls', 'broken', 'call.json'), '{ not json');
    const run = await cma(['--home', home, 'statusline']);
    expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
  });
});
