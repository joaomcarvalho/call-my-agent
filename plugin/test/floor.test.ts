import { afterAll, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server/index.ts';
import { Harness, connect, contextPatch, status, waitFor, type Side } from './fixtures/harness.ts';

const harnesses: Harness[] = [];
const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of closers) await close();
  for (const h of harnesses) await h.cleanup();
});

async function client(side: Side): Promise<Client> {
  const server = createServer(side.manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const c = new Client({ name: 'floor', version: '0.0.0' });
  await c.connect(clientTransport);
  closers.push(() => c.close());
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const result = await c.callTool({ name, arguments: args });
  const [content] = result.content as { type: string; text: string }[];
  return { isError: Boolean(result.isError), body: JSON.parse(content!.text) as Record<string, unknown> };
}

test('keep_floor on cma_say and cma_respond keeps the floor for a follow-up message', async () => {
  const h = new Harness();
  harnesses.push(h);
  const alice = await h.side('alice');
  const bob = await h.side('bob');
  const { session } = await connect(alice, bob);
  const a = await client(alice);
  const b = await client(bob);

  const held = await call(a, 'cma_say', { session, text: 'Answers to your questions.', keep_floor: true });
  expect(held).toMatchObject({ isError: false, body: { floor: 'you' } });
  const proposed = await call(a, 'cma_propose', { session, patch: contextPatch('Billing reads orders nightly.'), rationale: 'Context.' });
  expect(proposed).toMatchObject({ isError: false, body: { floor: 'peer' } });
  expect(alice.manager.runtime(session).log.at(-2)!.floor).toBe('hold');

  await waitFor(() => status(bob, session).floor === 'you' && status(bob, session).pending !== null, 'proposal at bob');
  const accepted = await call(b, 'cma_respond', { session, action: 'accept', keep_floor: true });
  expect(accepted).toMatchObject({ isError: false, body: { floor: 'you', version: 1 } });
  const said = await call(b, 'cma_say', { session, text: 'Accepted; one more thing.' });
  expect(said).toMatchObject({ isError: false, body: { floor: 'peer' } });

  await waitFor(() => status(alice, session).floor === 'you', 'floor back at alice');
  expect(await call(a, 'cma_say', { session, text: 'one', keep_floor: true })).toMatchObject({ isError: false });
  expect(await call(a, 'cma_say', { session, text: 'two', keep_floor: true })).toMatchObject({ isError: false });
  const capped = await call(a, 'cma_say', { session, text: 'three', keep_floor: true });
  expect(capped).toMatchObject({ isError: true, body: { error: 'INVALID_STATE' } });
}, 20_000);
