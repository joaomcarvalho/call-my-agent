import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const pluginDir = join(import.meta.dir, '..');
let root: string;
let copy: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cma-bundle-')));
  copy = join(root, 'plugin');
  cpSync(pluginDir, copy, {
    recursive: true,
    filter: (src) => !src.split('/').includes('node_modules'),
  });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.CLAUDE_CODE_MESSAGING_SOCKET;
  delete env.CLAUDE_CODE_MESSAGING_TOKEN;
  delete env.CLAUDE_PLUGIN_DATA;
  return { ...env, ...extra };
}

test('bundled MCP server starts from a copy of plugin/ alone and lists 17 tools', async () => {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [join(copy, 'dist', 'server.js')],
    cwd: root,
    env: cleanEnv({ HOME: join(root, 'home'), CMA_HOME: join(root, 'cma-home') }),
  });
  const client = new Client({ name: 'bundle-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(17);
    expect(tools.map((t) => t.name)).toContain('cma_start_call');
  } finally {
    await client.close();
  }
});

test('bundled disclosure hook blocks a private key from a copy of plugin/ alone', async () => {
  const key = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn', '-----END RSA PRIVATE KEY-----'].join('\n');
  const proc = Bun.spawn(['bun', join(copy, 'dist', 'disclosure.js')], {
    cwd: root,
    stdin: new Blob([
      JSON.stringify({
        tool_name: 'mcp__plugin_call-my-agent_cma__cma_say',
        tool_input: { session: 's1', text: `here: ${key}` },
      }),
    ]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: cleanEnv({ HOME: join(root, 'home') }),
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(2);
  expect(stderr).toContain('private-key');
});
