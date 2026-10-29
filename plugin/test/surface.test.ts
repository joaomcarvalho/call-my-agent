import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pluginDir = join(import.meta.dir, '..');
const repoRoot = join(pluginDir, '..');

// implementation-spec §4.3
const TOOLS = new Set([
  'cma_start_call',
  'cma_inspect_invite',
  'cma_join_call',
  'cma_say',
  'cma_propose',
  'cma_respond',
  'cma_withdraw',
  'cma_checkpoint',
  'cma_answer_checkpoint',
  'cma_request_signoff',
  'cma_plan_get',
  'cma_status',
  'cma_list_calls',
  'cma_wait',
  'cma_inbox',
  'cma_hangup',
  'cma_write_plan',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const skillFiles = walk(join(pluginDir, 'skills')).filter((f) => f.endsWith('.md'));
const skillMds = skillFiles.filter((f) => f.endsWith('SKILL.md'));

function frontmatter(file: string): Record<string, string> {
  const m = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`no frontmatter in ${file}`);
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fm;
}

describe('skills', () => {
  test('the seven expected skills exist', () => {
    const names = skillMds.map((f) => f.split('/').slice(-2)[0]).sort();
    expect(names).toEqual(['call', 'calls', 'catch-up', 'hangup', 'negotiate', 'pickup', 'sign']);
  });

  test('every SKILL.md has name and description frontmatter', () => {
    for (const f of skillMds) {
      const fm = frontmatter(f);
      expect(fm.name, f).toBe(f.split('/').slice(-2)[0]!);
      expect((fm.description ?? '').length, f).toBeGreaterThan(20);
    }
  });

  test('sign has disable-model-invocation true', () => {
    expect(frontmatter(join(pluginDir, 'skills/sign/SKILL.md'))['disable-model-invocation']).toBe('true');
  });

  test('every cma_ tool named in skills and agents exists in the spec tool list', () => {
    const files = [...skillFiles, ...walk(join(pluginDir, 'agents'))];
    const mentioned = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/\bcma_[a-z_]+/g)) mentioned.add(m[0]);
    expect(mentioned.size).toBeGreaterThan(0);
    for (const name of mentioned) expect(TOOLS.has(name), name).toBe(true);
  });

  test('negotiate mentions the tools the playbook depends on', () => {
    const text = readFileSync(join(pluginDir, 'skills/negotiate/SKILL.md'), 'utf8');
    for (const t of ['cma_propose', 'cma_checkpoint', 'cma_answer_checkpoint', 'cma_wait', 'cma_request_signoff', 'cma_hangup']) {
      expect(text).toContain(t);
    }
    expect(text).toContain('"op": "test"');
  });
});

describe('manifests', () => {
  const json = (p: string) => JSON.parse(readFileSync(join(repoRoot, p), 'utf8'));

  test('plugin.json, .mcp.json, hooks.json and marketplace.json match the documented fields', () => {
    expect(json('plugin/.claude-plugin/plugin.json')).toMatchObject({ name: 'call-my-agent', version: '0.1.0' });
    expect(json('plugin/.mcp.json').mcpServers.cma).toEqual({ command: 'bun', args: ['${CLAUDE_PLUGIN_ROOT}/server/index.ts'] });
    const hooks = json('plugin/hooks/hooks.json').hooks;
    expect(Object.keys(hooks).sort()).toEqual(['PreToolUse', 'SessionStart']);
    const matcher = new RegExp(`^(?:${hooks.PreToolUse[0].matcher})$`);
    for (const t of ['cma_say', 'cma_propose', 'cma_respond', 'cma_answer_checkpoint']) {
      expect(matcher.test(`mcp__plugin_call-my-agent_cma__${t}`), t).toBe(true);
    }
    expect(matcher.test('mcp__plugin_call-my-agent_cma__cma_status')).toBe(false);
    const mp = json('.claude-plugin/marketplace.json');
    expect(mp.plugins[0]).toMatchObject({ name: 'call-my-agent', source: './plugin' });
    expect(mp.owner.name).toBeTruthy();
  });

  test('context-scout is read-only on haiku', () => {
    const fm = frontmatter(join(pluginDir, 'agents/context-scout.md'));
    expect(fm.model).toBe('haiku');
    expect(fm.tools).toBe('Read, Grep, Glob');
  });
});

describe('call profile', () => {
  const profile = JSON.parse(readFileSync(join(pluginDir, 'profiles/call.json'), 'utf8')) as {
    permissions: { defaultMode: string; allow: string[]; deny: string[] };
  };
  const { allow, deny } = profile.permissions;

  test('denies write, shell, web and messaging tools', () => {
    for (const t of ['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'SendMessage']) expect(deny, t).toContain(t);
  });

  test('denies reads of env files, keys, ssh, aws and the CMA identity dir', () => {
    for (const r of ['Read(./.env*)', 'Read(**/*.pem)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.call-my-agent/identity/**)']) {
      expect(deny, r).toContain(r);
    }
    expect(deny.some((r) => r.startsWith('Read(') && r.includes('identity'))).toBe(true);
  });

  test('allows the plugin MCP tools and read-only file tools, in default permission mode', () => {
    expect(profile.permissions.defaultMode).toBe('default');
    for (const r of ['Read', 'Grep', 'Glob', 'mcp__plugin_call-my-agent_cma__*']) expect(allow, r).toContain(r);
  });

  test('no allow rule is also denied and no broad Agent allow exists', () => {
    for (const r of allow) expect(deny).not.toContain(r);
    expect(allow).not.toContain('Agent');
  });
});

describe('no permission relay', () => {
  test('no skill, hook, agent or manifest mentions the permission relay channel', () => {
    const needle = ['claude', 'channel', 'permission'].join('/');
    const hits = walk(pluginDir).filter((f) => !f.includes('/test/') && readFileSync(f, 'utf8').toLowerCase().includes(needle));
    expect(hits).toEqual([]);
  });

  test('skills never tell the model to sign or approve', () => {
    for (const f of skillMds) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/\b(?:call|use|run) `?cma_(?:sign|approve)/i);
    }
  });
});
