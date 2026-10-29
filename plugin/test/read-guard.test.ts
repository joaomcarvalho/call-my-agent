import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const guard = join(import.meta.dir, '..', 'hooks', 'read-guard.ts');
const repoRoot = join(import.meta.dir, '..', '..');

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cma-read-guard-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const home = join(tmp, 'home');
const root = join(home, 'cma');
const sibling = join(home, 'cma-other');
const repo = join(tmp, 'repo');
for (const d of [join(root, 'identity'), sibling, repo]) mkdirSync(d, { recursive: true });
writeFileSync(join(root, 'identity', 'human.key'), 'secret');
writeFileSync(join(sibling, 'x'), 'ok');
writeFileSync(join(repo, 'a.ts'), 'ok');
symlinkSync(join(root, 'identity'), join(repo, 'link'));

async function run(stdin: unknown, env: Record<string, string> = { CMA_HOME: root }) {
  const e: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home };
  delete e.CMA_HOME;
  delete e.CLAUDE_PLUGIN_DATA;
  Object.assign(e, env);
  const proc = Bun.spawn(['bun', guard], {
    stdin: new Blob([typeof stdin === 'string' ? stdin : JSON.stringify(stdin)]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: e,
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr };
}

const call = (tool_name: string, tool_input: Record<string, unknown>, cwd = repo, env?: Record<string, string>) =>
  run({ tool_name, tool_input, cwd }, env);

describe('read guard blocks (exit 2)', () => {
  test('blocks Read of the identity key', async () => {
    expect((await call('Read', { file_path: join(root, 'identity', 'human.key') })).code).toBe(2);
  });

  test('blocks Read through a symlink into the root', async () => {
    expect((await call('Read', { file_path: join(repo, 'link', 'human.key') })).code).toBe(2);
  });

  test('blocks Read through .. segments', async () => {
    expect((await call('Read', { file_path: join(repo, '..', 'home', 'cma', 'identity', '..', 'identity', 'human.key') })).code).toBe(2);
  });

  test('blocks Read of a relative path resolved against cwd', async () => {
    expect((await call('Read', { file_path: 'identity/human.key' }, root)).code).toBe(2);
  });

  test('blocks Grep with path set to the root', async () => {
    expect((await call('Grep', { pattern: 'x', path: root })).code).toBe(2);
  });

  test('blocks Grep without a path when cwd is inside the root', async () => {
    expect((await call('Grep', { pattern: 'x' }, join(root, 'identity'))).code).toBe(2);
  });

  test('blocks Glob with an absolute pattern under the root', async () => {
    expect((await call('Glob', { pattern: `${root}/**` })).code).toBe(2);
  });

  test('blocks Glob with no path when cwd is inside the root', async () => {
    expect((await call('Glob', { pattern: '**/*' }, root)).code).toBe(2);
  });

  test('blocks Read with ~ when the root is under HOME', async () => {
    expect((await call('Read', { file_path: '~/cma/identity/human.key' })).code).toBe(2);
  });

  test('blocks when the root comes from CLAUDE_PLUGIN_DATA', async () => {
    const r = await call('Read', { file_path: join(root, 'identity', 'human.key') }, repo, { CLAUDE_PLUGIN_DATA: root });
    expect(r.code).toBe(2);
  });

  test('blocks the default ~/.call-my-agent root', async () => {
    const r = await call('Read', { file_path: '~/.call-my-agent/identity/human.key' }, repo, {});
    expect(r.code).toBe(2);
  });

  test('fails closed with exit 2 on malformed input', async () => {
    expect((await run('not json')).code).toBe(2);
  });
});

describe('hooks.json registration', () => {
  test('registers the read guard for exactly Read, Grep, Glob and NotebookRead', async () => {
    const hooks = await Bun.file(join(import.meta.dir, '..', 'hooks', 'hooks.json')).json();
    const entry = hooks.hooks.PreToolUse.find((e: { hooks: Array<{ args: string[] }> }) => e.hooks[0]?.args[0]?.endsWith('read-guard.ts'));
    const re = new RegExp(entry.matcher);
    for (const t of ['Read', 'Grep', 'Glob', 'NotebookRead']) expect(re.test(t)).toBe(true);
    for (const t of ['ReadMcp', 'MyRead', 'Edit', 'Write', 'Bash']) expect(re.test(t)).toBe(false);
  });
});

describe('read guard allows (exit 0)', () => {
  test('allows Read of a repo file', async () => {
    expect((await call('Read', { file_path: join(repo, 'a.ts') })).code).toBe(0);
  });

  test('allows Read in a sibling directory sharing the root name prefix', async () => {
    expect((await call('Read', { file_path: join(sibling, 'x') })).code).toBe(0);
  });

  test('allows Grep in the repo, including a regex pattern containing a slash', async () => {
    expect((await call('Grep', { pattern: `${root}/x`, path: repo })).code).toBe(0);
  });

  test('allows Glob in the repo', async () => {
    expect((await call('Glob', { pattern: '**/*.ts', path: repoRoot })).code).toBe(0);
  });
});
