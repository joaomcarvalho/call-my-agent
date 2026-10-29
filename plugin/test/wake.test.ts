import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectionHeader } from '../server/format.ts';
import { Inbox, MAX_WAKES_WITHOUT_FLOOR, wakeOf } from '../server/inbox.ts';
import { fakeMessagingSocket, waitFor, type FakeMessagingSocket } from './fixtures/harness.ts';

const SESSION = 'ses_waketest';
const HEADER: InjectionHeader = { code: 'CMA-ABCD-EFGH', peer: 'bob', badge: 'billing', state: 'DISCUSSING', floor: 'you', version: 1 };
const BATCH_MS = 50;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cma-wake-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(): Promise<{ box: Inbox; fake: FakeMessagingSocket }> {
  const dir = tempDir();
  const fake = await fakeMessagingSocket(dir);
  cleanups.push(() => fake.close());
  const box = new Inbox({ root: dir, env: fake.env, batchMs: BATCH_MS, header: () => HEADER });
  cleanups.push(() => box.close());
  return { box, fake };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, BATCH_MS * 4));
let seq = 0;
const item = (type: string) => ({ relay_seq: ++seq, line: `#${seq} ${type} text` });

describe('F5: no wake floods', () => {
  test('floor messages wake, the five control types are quiet, everything else wakes until the streak cap', () => {
    for (const type of ['say', 'propose', 'counter', 'accept', 'reject'] as const) expect(wakeOf(type)).toBe('floor');
    for (const type of ['error', 'ask_user_pending', 'user_answer_summary', 'heartbeat', 'bye'] as const) expect(wakeOf(type)).toBe('quiet');
    for (const type of ['hello', 'welcome', 'amend', 'withdraw', 'request_signoff', 'unfreeze', 'signoff', 'plan_final', 'resolve', 'abort'] as const) {
      expect(wakeOf(type)).toBe('other');
    }
  });

  test('control messages are queued without an injection and ride along with the next floor message', async () => {
    const { box, fake } = await setup();
    for (let i = 0; i < 25; i++) box.push(SESSION, item('error'), 'quiet');
    await settle();
    expect(fake.injected).toHaveLength(0);
    expect(box.pending(SESSION)).toBe(25);

    box.push(SESSION, item('say'), 'floor');
    await waitFor(() => fake.injected.length === 1, 'one injection');
    expect(fake.injected[0]).toStartWith('[call-my-agent] 26 new messages');
    expect(box.pending(SESSION)).toBe(0);
  });

  test(`after ${MAX_WAKES_WITHOUT_FLOOR} peer messages without a floor message injection stops until a floor message arrives`, async () => {
    const { box, fake } = await setup();
    for (let i = 0; i < MAX_WAKES_WITHOUT_FLOOR; i++) box.push(SESSION, item('withdraw'), 'other');
    await waitFor(() => fake.injected.length === 1, 'the first ten');

    box.push(SESSION, item('withdraw'), 'other');
    box.push(SESSION, item('amend'), 'other');
    await settle();
    expect(fake.injected).toHaveLength(1);
    expect(box.pending(SESSION)).toBe(2);

    box.push(SESSION, item('say'), 'floor');
    await waitFor(() => fake.injected.length === 2, 'the floor message');
    expect(fake.injected[1]).toStartWith('[call-my-agent] 3 new messages');

    box.push(SESSION, item('withdraw'), 'other');
    await waitFor(() => fake.injected.length === 3, 'injection resumes after a floor message');
  });

  test('a control message does not end a cma_wait; it is returned with the next floor message', async () => {
    const box = new Inbox({ root: tempDir(), env: {}, header: () => HEADER });
    cleanups.push(() => box.close());
    const waiting = box.wait(SESSION, 5000);
    let ended = false;
    void waiting.then(() => (ended = true));
    box.push(SESSION, item('ask_user_pending'), 'quiet');
    await settle();
    expect(ended).toBe(false);
    box.push(SESSION, item('say'), 'floor');
    const got = await waiting;
    expect(got.map((i) => i.line.split(' ')[1])).toEqual(['ask_user_pending', 'say']);
  });

  test('queued control messages are returned by a cma_wait that times out', async () => {
    const box = new Inbox({ root: tempDir(), env: {}, header: () => HEADER });
    cleanups.push(() => box.close());
    const waiting = box.wait(SESSION, 150);
    box.push(SESSION, item('error'), 'quiet');
    expect((await waiting).map((i) => i.line.split(' ')[1])).toEqual(['error']);
  });
});
