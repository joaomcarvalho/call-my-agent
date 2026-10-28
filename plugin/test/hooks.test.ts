import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooksDir = join(import.meta.dir, '..', 'hooks');
const TOOL = 'mcp__plugin_call-my-agent_cma__cma_say';

async function run(script: string, opts: { stdin?: unknown; env?: Record<string, string> } = {}) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.CLAUDE_CODE_MESSAGING_SOCKET;
  delete env.CLAUDE_CODE_MESSAGING_TOKEN;
  delete env.CLAUDE_PLUGIN_DATA;
  Object.assign(env, opts.env);
  const proc = Bun.spawn(['bun', join(hooksDir, script)], {
    stdin: new Blob([typeof opts.stdin === 'string' ? opts.stdin : JSON.stringify(opts.stdin ?? {})]),
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

const disclose = (toolInput: Record<string, unknown>, env?: Record<string, string>) =>
  run('disclosure.ts', { stdin: { tool_name: TOOL, tool_input: toolInput }, env });

describe('disclosure hook blocks (exit 2)', () => {
  test('blocks a PEM private key', async () => {
    const key = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn', '-----END RSA PRIVATE KEY-----'].join('\n');
    const r = await disclose({ session: 's1', text: `here: ${key}` });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('private-key');
  });

  test('blocks an AWS access key id', async () => {
    const r = await disclose({ session: 's1', text: `key is ${'AKIA'}IOSFODNN7EXAMPLE` });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('aws-access-key');
  });

  test('blocks a GitHub token', async () => {
    const r = await disclose({ session: 's1', text: `use ${'ghp_'}${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}` });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('github-token');
  });

  test('blocks a password assignment', async () => {
    const r = await disclose({ session: 's1', text: 'config: password = "hunter2hunter2"' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('secret-assignment');
  });

  test('blocks a 40-char random base64 string', async () => {
    const r = await disclose({ session: 's1', text: 'blob q8Zx3Lm0Vb7Nc2Rk9Td5Hs1Jw6Pf4Ya8Ge3Uo2Xi' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('high-entropy-string');
  });

  test('blocks a .env style line', async () => {
    const r = await disclose({ session: 's1', text: 'DATABASE_URL=postgres://u:p@h/db' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('env-assignment');
  });

  test('blocks a 17 KB text field', async () => {
    const r = await disclose({ session: 's1', text: 'a plain sentence. '.repeat(1000).slice(0, 17 * 1024) });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('16 KB');
  });

  test('blocks a secret nested inside a JSON Patch value', async () => {
    const patch = [{ op: 'add', path: '/sections/-', value: { md: `aws ${'AKIA'}IOSFODNN7EXAMPLE` } }];
    expect((await run('disclosure.ts', { stdin: { tool_name: TOOL, tool_input: { session: 's1', patch } } })).code).toBe(2);
  });

  test('blocks when the hook input is not JSON', async () => {
    expect((await run('disclosure.ts', { stdin: 'not json' })).code).toBe(2);
  });
});

describe('disclosure hook allows (exit 0)', () => {
  test('allows a normal paragraph with a file:line reference', async () => {
    const text =
      'Our order total is read in src/routes/orders.js:42 as a float. We would like to add total_cents and keep total for 90 days while billing migrates its refund job.';
    expect((await disclose({ session: 's1', text })).code).toBe(0);
  });

  test('allows an OpenAPI snippet', async () => {
    const text = [
      'paths:',
      '  /orders/{id}:',
      '    get:',
      '      operationId: getOrder',
      '      responses:',
      "        '200':",
      '          content:',
      '            application/json:',
      '              schema:',
      "                $ref: '#/components/schemas/Order'",
      'components:',
      '  schemas:',
      '    Order:',
      '      type: object',
      '      required: [id, total_cents]',
      '      properties:',
      '        id: { type: string, format: uuid }',
      '        total_cents: { type: integer, minimum: 0 }',
    ].join('\n');
    expect((await disclose({ session: 's1', text })).code).toBe(0);
  });

  test('allows a JSON Patch with hashes and long paths', async () => {
    const patch = [
      { op: 'test', path: '/version', value: 3 },
      {
        op: 'add',
        path: '/sections/-',
        value: {
          id: 'consumer-call-sites',
          title: 'Consumer call sites',
          type: 'checklist',
          owner: 'B',
          md: '- `src/clients/orders.ts:88` reads `order.total` as a float',
          artifacts: [{ name: 'orders.yaml', format: 'openapi-3.1', content: 'openapi: 3.1.0', sha256: `sha256:${'ab12'.repeat(16)}` }],
        },
      },
      { op: 'add', path: '/decisions/-', value: { id: 'd1', text: 'Add total_cents', kind: 'breaking_change', decided_by: 'agent-assumed', decided_in: null } },
    ];
    const r = await run('disclosure.ts', { stdin: { tool_name: TOOL, tool_input: { session: 's1', patch, rationale: 'additive first' } } });
    expect(r.code).toBe(0);
  });
});

const GH = `${'ghp_'}aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5`;
const AWS = `${'AKIA'}IOSFODNN7EXAMPLE`;
const PREFIX = 'mcp__plugin_call-my-agent_cma__';

describe('disclosure hook scan bypasses are blocked', () => {
  test('blocks a 64-char hex secret', async () => {
    const r = await disclose({ session: 's1', text: 'the signing key is 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' });
    expect(r.code).toBe(2);
  });

  test('blocks a 64-char hex secret under an unrelated key', async () => {
    expect((await disclose({ session: 's1', note: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' })).code).toBe(2);
  });

  test('blocks a key split with a zero-width space', async () => {
    expect((await disclose({ session: 's1', text: `${AWS.slice(0, 10)}​${AWS.slice(10)}` })).code).toBe(2);
  });

  test('blocks a token spelled with spaces between characters', async () => {
    expect((await disclose({ session: 's1', text: GH.split('').join(' ') })).code).toBe(2);
  });

  test('blocks fullwidth-letter token variants via NFKC', async () => {
    const wide = [...AWS].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');
    expect((await disclose({ session: 's1', text: wide })).code).toBe(2);
  });

  test('blocks a secret split across two fields', async () => {
    expect((await disclose({ session: 's1', text: GH.slice(0, 20), rationale: GH.slice(20) })).code).toBe(2);
  });

  test('blocks a secret encoded as char codes in a patch value', async () => {
    const patch = [{ op: 'test', path: '/x', value: [...GH].map((c) => c.charCodeAt(0)) }];
    expect((await disclose({ session: 's1', patch })).code).toBe(2);
  });

  test('blocks a secret placed in an object key', async () => {
    expect((await disclose({ session: 's1', patch: [{ op: 'add', path: '/x', value: { [GH]: 1 } }] })).code).toBe(2);
  });
});

describe('disclosure hook fails closed', () => {
  test('exits 2 for a deeply nested tool_input', async () => {
    const deep = '['.repeat(60000) + ']'.repeat(60000);
    const stdin = `{"tool_name":"${PREFIX}cma_propose","tool_input":{"session":"s","rationale":"${GH}","patch":[{"op":"test","path":"/x","value":${deep}}]}}`;
    const r = await run('disclosure.ts', { stdin, env: { CMA_HOME: '/nonexistent-cma' } });
    expect(r.code).toBe(2);
  });

  test('exits 2 for input nested past 64 levels', async () => {
    const deep = '['.repeat(70) + ']'.repeat(70);
    expect((await run('disclosure.ts', { stdin: `{"tool_name":"${TOOL}","tool_input":{"v":${deep}}}` })).code).toBe(2);
  });

  test('exits 2 for more than 20000 nodes', async () => {
    expect((await disclose({ session: 's1', list: Array.from({ length: 20001 }, () => 1) })).code).toBe(2);
  });

  test('exits 2 when the audit log cannot be written', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cma-ro-'));
    mkdirSync(join(home, 'calls', 'sess-2', 'audit.jsonl'), { recursive: true });
    expect((await disclose({ session: 'sess-2', text: 'fine' }, { CMA_HOME: home })).code).toBe(2);
  });

  test('exits 2 when the hook input is JSON null', async () => {
    expect((await run('disclosure.ts', { stdin: 'null' })).code).toBe(2);
  });
});

describe('disclosure hook allows hashes in hash fields', () => {
  test('allows 64-hex values under checkpoint_ref and result_hash and an inline sha256 hash', async () => {
    const h = 'ab12'.repeat(16);
    const r = await disclose({ session: 's1', checkpoint_ref: h, nested: { result_hash: h }, text: `see sha256:${h} in the plan` });
    expect(r.code).toBe(0);
  });
});

describe('hooks.json matcher', () => {
  const hooks = JSON.parse(readFileSync(join(hooksDir, 'hooks.json'), 'utf8'));
  const re = new RegExp(hooks.hooks.PreToolUse[0].matcher);
  const covered = ['say', 'propose', 'respond', 'answer_checkpoint', 'checkpoint', 'hangup', 'start_call'];
  const others = ['inspect_invite', 'join_call', 'withdraw', 'request_signoff', 'plan_get', 'status', 'list_calls', 'wait', 'inbox', 'write_plan'];

  test('matches every tool that sends text to the peer', () => {
    for (const t of covered) expect(re.test(`${PREFIX}cma_${t}`)).toBe(true);
  });

  test('matches no other cma tool or look-alike name', () => {
    for (const t of others) expect(re.test(`${PREFIX}cma_${t}`)).toBe(false);
    expect(re.test(`${PREFIX}cma_say_more`)).toBe(false);
    expect(re.test(`x${PREFIX}cma_say`)).toBe(false);
  });
});

describe('disclosure hook audit', () => {
  test('appends block and allow verdicts to the call audit log without the secret', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cma-audit-'));
    mkdirSync(join(home, 'calls', 'sess-1'), { recursive: true });
    const env = { CMA_HOME: home };
    await disclose({ session: 'sess-1', text: 'fine' }, env);
    await disclose({ session: 'sess-1', text: `${'AKIA'}IOSFODNN7EXAMPLE` }, env);
    const lines = readFileSync(join(home, 'calls', 'sess-1', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.verdict)).toEqual(['allow', 'block']);
    expect(lines[1].reasons).toEqual(['aws-access-key']);
    expect(JSON.stringify(lines)).not.toContain('IOSFODNN7EXAMPLE');
  });
});

describe('session-start hook', () => {
  test('writes session-env.json with mode 0600 and the right values', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cma-ss-'));
    const r = await run('session-start.ts', {
      env: { CMA_HOME: home, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/x.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'tok123' },
    });
    expect(r.code).toBe(0);
    const file = join(home, 'session-env.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ socket: '/tmp/x.sock', token: 'tok123' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('exits 0 and writes nothing without the env vars', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cma-ss-'));
    const r = await run('session-start.ts', { env: { CMA_HOME: home } });
    expect(r.code).toBe(0);
    expect(existsSync(join(home, 'session-env.json'))).toBe(false);
  });

  test('prints a reminder of active calls as additional context', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cma-ss-'));
    mkdirSync(join(home, 'calls', 'sess-9'), { recursive: true });
    await Bun.write(join(home, 'calls', 'sess-9', 'call.json'), JSON.stringify({ session: 'sess-9', party: 'A', peer: { human: 'bea' } }));
    const r = await run('session-start.ts', { env: { CMA_HOME: home } });
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('sess-9');
    expect(out.hookSpecificOutput.additionalContext).toContain('bea');
  });
});
