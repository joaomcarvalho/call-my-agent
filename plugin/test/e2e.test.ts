import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { fourWordCode, verifyAgreementFile } from '@cma/protocol';
import { callPaths, identityPaths, loadOrCreateIdentity, readLog } from '../server/store.ts';
import {
  Harness,
  PROFILES,
  TOPIC,
  breakingPatch,
  connect,
  contextPatch,
  cursorPatch,
  freezeSimplePlan,
  signAndClose,
  status,
  totalCountPatch,
  waitFor,
} from './fixtures/harness.ts';

const SAY_TEXT = 'Today GET /v1/orders uses offset pagination and returns amount as a decimal string (src/routes/orders.js:42).';

const harnesses: Harness[] = [];
function harness(): Harness {
  const h = new Harness();
  harnesses.push(h);
  return h;
}
afterAll(async () => {
  for (const h of harnesses) await h.cleanup();
});

describe('full call between two managers', () => {
  let completed: { h: Harness; session: string } | null = null;

  test('AC1: start, join, negotiate, checkpoint, sign and close yield byte-identical agreement files that verify', async () => {
    const h = harness();
    const alice = await h.side('alice');
    const bob = await h.side('bob');

    const { session, started, joined, inspected } = await connect(alice, bob);
    expect(started.code).toMatch(/^CMA-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(inspected.problems).toEqual([]);
    expect(inspected.charter as string).toContain(`<counterparty_data call="${session}">\ntopic: ${TOPIC}\n`);
    expect(inspected.fingerprint).toBe(started.fingerprint);
    expect(joined.fingerprint).toBe(started.fingerprint);
    const aliceKey = alice.manager.identity().agent.keyId;
    const bobKey = bob.manager.identity().agent.keyId;
    expect(joined.four_words).toBe(fourWordCode(aliceKey, bobKey));
    expect(status(alice, session).four_words).toBe(joined.four_words);
    expect(status(alice, session).floor).toBe('you');
    expect(status(bob, session).floor).toBe('peer');

    await alice.manager.say({ session, text: SAY_TEXT, evidence: [{ ref: 'src/routes/orders.js:42' }] });
    const heard = await bob.manager.wait({ session, timeout_s: 5 });
    expect(heard.messages as string).toContain(SAY_TEXT);
    expect(heard.messages as string).toContain(`<counterparty_data call="${session}">`);
    expect(heard.floor).toBe('you');

    const proposed = await bob.manager.propose({ session, patch: cursorPatch(), rationale: 'Offsets skip orders when new ones arrive mid-sync.' });
    expect(proposed.state).toBe('PROPOSAL_PENDING');
    expect(proposed.floor).toBe('peer');
    await waitFor(() => status(alice, session).pending !== null, 'proposal at alice');

    await alice.manager.respond({
      session,
      action: 'counter',
      reasons: ['billing also needs total_count to detect truncated syncs'],
      patch: totalCountPatch(),
      rationale: 'Cursor pagination plus total_count.',
    });
    await waitFor(() => (status(bob, session).pending as { type?: string } | null)?.type === 'counter', 'counter at bob');
    const accepted = await bob.manager.respond({ session, action: 'accept' });
    expect(accepted.version).toBe(1);
    await waitFor(() => status(alice, session).version === 1, 'v1 at alice');

    const askA = await alice.manager.checkpoint({ session, question: 'May we rename amount to amount_minor with a 30-day dual-write?', kind: 'breaking_change' });
    expect(askA.awaiting_human).toEqual({ you: true, peer: false });
    const answerA = await alice.manager.answerCheckpoint({
      session,
      checkpoint_id: askA.checkpoint_id as string,
      shareable_summary: 'Alice approves the rename with a 30-day dual-write window.',
    });
    await alice.manager.propose({
      session,
      patch: breakingPatch(),
      kinds: ['breaking_change'],
      rationale: 'Integer minor units remove rounding errors.',
      checkpoint_ref: answerA.checkpoint_ref as string,
    });
    await waitFor(() => status(bob, session).pending !== null, 'breaking proposal at bob');

    const askB = await bob.manager.checkpoint({ session, question: 'Accept the amount rename on a 30-day timeline?', kind: 'breaking_change' });
    const answerB = await bob.manager.answerCheckpoint({
      session,
      checkpoint_id: askB.checkpoint_id as string,
      shareable_summary: 'Bob accepts the rename on the 30-day timeline.',
    });
    const v2 = await bob.manager.respond({ session, action: 'accept', checkpoint_ref: answerB.checkpoint_ref as string });
    expect(v2.version).toBe(2);
    await waitFor(() => status(alice, session).version === 2, 'v2 at alice');

    const request = await bob.manager.requestSignoff({ session });
    await waitFor(() => status(alice, session).signoff_request !== null, 'signoff request at alice');
    const plan = alice.manager.planGet({ session, format: 'markdown' });
    expect(plan.plan_hash).toBe(request.plan_hash);
    expect(plan.md_hash).toBe(request.md_hash);
    await alice.manager.respond({ session, action: 'accept' });

    const { a, b } = await signAndClose(alice, bob, session);
    expect(existsSync(callPaths(alice.home, session).signoffSent)).toBe(true);
    expect(existsSync(callPaths(bob.home, session).signoffSent)).toBe(true);
    expect(a.path).not.toBe(b.path);
    expect((a.path as string).startsWith(alice.repo)).toBe(true);
    const fileA = readFileSync(a.path as string);
    const fileB = readFileSync(b.path as string);
    expect(fileA.equals(fileB)).toBe(true);
    const verdict = verifyAgreementFile(fileA.toString('utf8'));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.planHash).toBe(request.plan_hash as `sha256:${string}`);
      expect(verdict.signers.A.human).toBe(PROFILES.alice!.human);
      expect(verdict.signers.B.human).toBe(PROFILES.bob!.human);
    }
    expect(status(alice, session).state).toBe('CLOSED');
    expect(status(bob, session).state).toBe('CLOSED');
    expect(readLog(alice.home, session).map((e) => e.id)).toEqual(readLog(bob.home, session).map((e) => e.id));

    completed = { h, session };
  }, 30_000);

  test('AC2: the relay database holds no plaintext after the full call', () => {
    expect(completed).not.toBeNull();
    const payloads = completed!.h.payloads();
    expect(payloads.length).toBe(20);
    for (const payload of payloads) {
      expect(payload).not.toContain(TOPIC);
      expect(payload).not.toContain(SAY_TEXT);
      expect(payload).not.toContain('"type"');
      expect(Object.keys(JSON.parse(payload)).sort()).toEqual(['c', 'e', 'n']);
    }
  });
});

test('AC4: a restarted server resumes the call from disk, receives what it missed and completes', async () => {
  const h = harness();
  const alice = await h.side('alice');
  const bob = await h.side('bob');
  const { session } = await connect(alice, bob);

  await alice.manager.say({ session, text: 'first from alice' });
  await waitFor(() => status(bob, session).floor === 'you', 'floor at bob');
  await bob.manager.say({ session, text: 'first from bob' });
  await waitFor(() => status(alice, session).floor === 'you', 'floor at alice');

  await bob.manager.close();
  await alice.manager.say({ session, text: 'sent while bob was offline' });

  const bob2 = await h.side('bob');
  const missed = await bob2.manager.wait({ session, timeout_s: 5 });
  expect(missed.messages as string).toContain('sent while bob was offline');
  expect(missed.messages as string).not.toContain('first from alice');
  expect(missed.floor).toBe('you');

  await bob2.manager.propose({ session, patch: contextPatch('Billing pages through orders nightly.'), rationale: 'Record the context.' });
  await waitFor(() => status(alice, session).pending !== null, 'proposal at alice');
  await alice.manager.respond({ session, action: 'accept' });
  await waitFor(() => status(bob2, session).version === 1, 'v1 at bob');
  await alice.manager.requestSignoff({ session });
  await waitFor(() => status(bob2, session).signoff_request !== null, 'signoff request at bob');
  await bob2.manager.respond({ session, action: 'accept' });

  const { a, b } = await signAndClose(alice, bob2, session);
  expect(readFileSync(a.path as string).equals(readFileSync(b.path as string))).toBe(true);
  const ids = readLog(bob2.home, session).map((e) => e.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(readLog(alice.home, session).map((e) => e.id));
}, 30_000);

test('AC9: the server reaches FROZEN with identity/human.key unreadable', async () => {
  const h = harness();
  const { home } = h.paths('alice');
  loadOrCreateIdentity(home, PROFILES.alice);
  const humanKey = identityPaths(home).humanKey;
  chmodSync(humanKey, 0o000);
  expect(() => readFileSync(humanKey)).toThrow();

  const alice = await h.side('alice');
  const bob = await h.side('bob');
  const { session } = await connect(alice, bob);
  await freezeSimplePlan(alice, bob, session);

  expect(status(alice, session).state).toBe('FROZEN');
  expect(statSync(humanKey).mode & 0o777).toBe(0);
}, 30_000);
