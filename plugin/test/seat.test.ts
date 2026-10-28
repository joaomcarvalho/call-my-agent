import { afterAll, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { pendingJoinPath, readAudit, readCallRecord, readPendingJoin, writeCallRecord, writePendingJoin } from '../server/store.ts';
import { Harness, status, waitFor, type Side } from './fixtures/harness.ts';

const harnesses: Harness[] = [];
function harness(): Harness {
  const h = new Harness();
  harnesses.push(h);
  return h;
}
afterAll(async () => {
  for (const h of harnesses) await h.cleanup();
});

const STALE_TOKEN = 'A'.repeat(43);

async function bothDiscussing(alice: Side, bob: Side, session: string): Promise<void> {
  await waitFor(() => status(alice, session).state === 'DISCUSSING' && status(bob, session).state === 'DISCUSSING', 'both DISCUSSING');
}

async function invited(h: Harness): Promise<{ alice: Side; bob: Side; session: string; invite: string }> {
  const alice = await h.side('alice');
  const bob = await h.side('bob');
  const started = await alice.manager.startCall({ peer: 'bob', topic: 'Orders API' });
  return { alice, bob, session: started.session as string, invite: started.invite as string };
}

test('a restart between inspect and join reuses the seat persisted at inspect and joins', async () => {
  const h = harness();
  const { alice, bob, session, invite } = await invited(h);

  await bob.manager.inspectInvite({ invite });
  const pending = pendingJoinPath(bob.home, session);
  expect(statSync(pending).mode & 0o777).toBe(0o600);
  const seat = readPendingJoin(bob.home, session)!;
  await bob.manager.close();

  const restarted = await h.side('bob');
  const joined = await restarted.manager.joinCall({ invite });
  expect(joined.state).toBe('HANDSHAKE');
  await bothDiscussing(alice, restarted, session);
  expect(readCallRecord(restarted.home, session).token).toBe(seat.token);
  expect(existsSync(pending)).toBe(false);
}, 20_000);

test('a pending seat whose token the relay no longer accepts is regained with a resume proof', async () => {
  const h = harness();
  const { alice, bob, session, invite } = await invited(h);

  await bob.manager.inspectInvite({ invite });
  writePendingJoin(bob.home, { ...readPendingJoin(bob.home, session)!, token: STALE_TOKEN });

  await bob.manager.joinCall({ invite });
  await bothDiscussing(alice, bob, session);
  expect(readCallRecord(bob.home, session).token).not.toBe(STALE_TOKEN);
}, 20_000);

test('a lost pending seat is retaken by joining again with a resume proof', async () => {
  const h = harness();
  const { alice, bob, session, invite } = await invited(h);

  await bob.manager.inspectInvite({ invite });
  await bob.manager.close();
  const restarted = await h.side('bob');
  writePendingJoin(restarted.home, { ...readPendingJoin(restarted.home, session)!, room: 'rsomeotherroom0000' });

  await restarted.manager.joinCall({ invite });
  await bothDiscussing(alice, restarted, session);
}, 20_000);

test('a call whose stored token was lost resumes its seat on restart and keeps receiving', async () => {
  const h = harness();
  const { alice, bob, session, invite } = await invited(h);
  await bob.manager.joinCall({ invite });
  await bothDiscussing(alice, bob, session);

  await bob.manager.close();
  writeCallRecord(bob.home, { ...readCallRecord(bob.home, session), token: STALE_TOKEN });
  await alice.manager.say({ session, text: 'said while bob had no valid token' });

  const restarted = await h.side('bob');
  const heard = await restarted.manager.wait({ session, timeout_s: 5 });
  expect(heard.messages as string).toContain('said while bob had no valid token');
  expect(readCallRecord(restarted.home, session).token).not.toBe(STALE_TOKEN);
  expect(readAudit(restarted.home, session).some((r) => r.kind === 'seat_resumed')).toBe(true);
}, 20_000);
