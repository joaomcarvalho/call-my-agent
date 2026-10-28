import { afterAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decodeInvite, encodeInvite, generateSigningKey, sha256Hash, type Hash } from '@cma/protocol';
import { ToolError } from '../server/call.ts';
import { createServer } from '../server/index.ts';
import { callPaths, readAudit } from '../server/store.ts';
import { Harness, connect, freezeSimplePlan, status, waitFor, writeSignoff, type Side } from './fixtures/harness.ts';

const harnesses: Harness[] = [];
function harness(): Harness {
  const h = new Harness();
  harnesses.push(h);
  return h;
}
afterAll(async () => {
  for (const h of harnesses) await h.cleanup();
});

async function rejection(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('expected a ToolError');
}

async function tamperedJoinIsRefused(tamper: (invite: ReturnType<typeof decodeInvite>) => void, reason: RegExp): Promise<void> {
  const h = harness();
  const alice = await h.side('alice');
  const bob = await h.side('bob');
  const started = await alice.manager.startCall({ peer: 'bob', topic: 'Orders API' });
  const session = started.session as string;
  const invite = decodeInvite(started.invite as string);
  tamper(invite);
  const forged = encodeInvite(invite);

  const inspected = await bob.manager.inspectInvite({ invite: forged });
  expect((inspected.problems as string[]).join('\n')).toMatch(reason);
  const err = await rejection(bob.manager.joinCall({ invite: forged }));
  expect(err.code).toBe('CHARTER_MISMATCH');
  expect(err.detail).toMatch(reason);

  expect(h.messageCount()).toBe(1);
  expect(existsSync(callPaths(bob.home, session).dir)).toBe(false);
  expect(bob.manager.listCalls()).toEqual({ calls: [] });
  expect(status(alice, session).state).toBe('INVITED');
}

test('AC3: joining with an invite whose fp is not the charter inviter is refused and nothing is sent', async () => {
  await tamperedJoinIsRefused((invite) => {
    invite.fp = generateSigningKey().keyId;
  }, /opened by key/);
}, 20_000);

test('AC3: joining with an invite whose charter_hash differs from the room is refused and nothing is sent', async () => {
  await tamperedJoinIsRefused((invite) => {
    invite.charter_hash = sha256Hash('another charter');
  }, /charter in the room differs/);
}, 20_000);

test('AC5: cma_say without the floor is a NOT_YOUR_FLOOR tool error and nothing reaches the relay', async () => {
  const h = harness();
  const alice = await h.side('alice');
  const bob = await h.side('bob');
  const { session } = await connect(alice, bob);
  expect(status(bob, session).floor).toBe('peer');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(bob.manager);
  await server.connect(serverTransport);
  const client = new Client({ name: 'ac5', version: '0.0.0' });
  await client.connect(clientTransport);

  const before = h.messageCount();
  const result = await client.callTool({ name: 'cma_say', arguments: { session, text: 'out of turn' } });
  expect(result.isError).toBe(true);
  const [content] = result.content as { type: string; text: string }[];
  expect(JSON.parse(content!.text)).toMatchObject({ error: 'NOT_YOUR_FLOOR' });

  const direct = await rejection(bob.manager.say({ session, text: 'out of turn again' }));
  expect(direct.code).toBe('NOT_YOUR_FLOOR');
  expect(h.messageCount()).toBe(before);
  expect(readAudit(bob.home, session).filter((r) => r.kind === 'send_refused')).toHaveLength(2);

  await client.close();
  await server.close();
}, 20_000);

async function expectSignoffRejected(h: Harness, side: Side, session: string, before: number, reason: RegExp): Promise<void> {
  const paths = callPaths(side.home, session);
  await waitFor(() => existsSync(paths.signoffRejected) && !existsSync(paths.signoff), 'signoff.rejected.json');
  expect(h.messageCount()).toBe(before);
  const audit = readAudit(side.home, session).filter((r) => r.kind === 'signoff_rejected');
  expect(String(audit.at(-1)?.reason)).toMatch(reason);
  expect(status(side, session).signoffs).toEqual({ you: false, peer: false });
}

test('AC7: a signoff.json with a wrong md_hash or a foreign key is rejected locally, renamed and never sent', async () => {
  const h = harness();
  const alice = await h.side('alice');
  const bob = await h.side('bob');
  const { session } = await connect(alice, bob);
  await freezeSimplePlan(alice, bob, session);
  const paths = callPaths(alice.home, session);

  let before = h.messageCount();
  writeSignoff(alice, session, { mdHash: sha256Hash('a different rendering') as Hash });
  await expectSignoffRejected(h, alice, session, before, /md_hash/);

  before = h.messageCount();
  writeSignoff(alice, session, { humanSecretKey: generateSigningKey().secretKey });
  await expectSignoffRejected(h, alice, session, before, /human_key/);
  expect(status(alice, session).state).toBe('FROZEN');

  writeSignoff(alice, session);
  await waitFor(() => existsSync(paths.signoffSent), 'signoff.sent.json');
  await waitFor(() => (status(bob, session).signoffs as { peer: boolean }).peer, 'signoff at bob');
}, 20_000);
