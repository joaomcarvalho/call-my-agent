import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server/index.ts';
import { CallManager } from '../server/manager.ts';

// implementation-spec §4.3
const TOOLS = [
  'cma_answer_checkpoint',
  'cma_checkpoint',
  'cma_hangup',
  'cma_inbox',
  'cma_inspect_invite',
  'cma_join_call',
  'cma_list_calls',
  'cma_plan_get',
  'cma_propose',
  'cma_request_signoff',
  'cma_respond',
  'cma_say',
  'cma_start_call',
  'cma_status',
  'cma_wait',
  'cma_withdraw',
  'cma_write_plan',
];

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connected(): Promise<Client> {
  const home = mkdtempSync(join(tmpdir(), 'cma-mcp-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const manager = new CallManager({ home, env: {}, assumeCallSession: true, repoRoot: home });
  cleanups.push(() => manager.close());
  await manager.init();
  const server = createServer(manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(clientTransport);
  cleanups.push(() => client.close());
  return client;
}

test('AC8: the server lists exactly the §4.3 tools and none that signs', async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  expect(names).toEqual(TOOLS);
  expect(names.filter((name) => name.includes('sign'))).toEqual(['cma_request_signoff']);
  for (const tool of tools) expect(tool.description?.length ?? 0).toBeGreaterThan(10);
});

test('AC8: tool results are compact JSON and unknown calls are tool errors', async () => {
  const client = await connected();
  const listed = await client.callTool({ name: 'cma_list_calls', arguments: {} });
  expect(listed.isError).toBeFalsy();
  const [text] = listed.content as { type: string; text: string }[];
  expect(JSON.parse(text!.text)).toEqual({ calls: [] });

  const missing = await client.callTool({ name: 'cma_status', arguments: { session: 'ses_nope' } });
  expect(missing.isError).toBe(true);
  const [error] = missing.content as { type: string; text: string }[];
  expect(JSON.parse(error!.text)).toMatchObject({ error: 'UNKNOWN_CALL' });
});
