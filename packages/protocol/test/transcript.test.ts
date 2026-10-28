import { describe, expect, test } from 'bun:test';
import { planHash } from '../src/plan.ts';
import { markdownHash } from '../src/render.ts';
import { replay, validateNext } from '../src/state.ts';
import type { Envelope } from '../src/types.ts';
import { expectAgreement } from './fixtures/deliver.ts';
import { JOIN_SECRET, WORKED_STEPS, workedTranscript } from './fixtures/transcript.ts';

const opts = { joinSecret: JOIN_SECRET };

/** Deterministic permutation, so the shuffle is the same on every run. */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  let seed = 42;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('worked transcript', () => {
  test('AC1: replays to CLOSED at version 2 with nothing rejected', () => {
    const { t, ids } = workedTranscript();
    const r = replay(t.log, opts);

    expect(r.state).toBe('CLOSED');
    expect(r.version).toBe(2);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toEqual(WORKED_STEPS.map((step) => ids[step]!));
    expect(r.planHash).toBe(planHash(r.plan!));
    expect(r.frozen).toEqual({ version: 2, hash: r.planHash!, mdHash: markdownHash(r.plan!) });
    expect(r.signoffs.A?.id).toBe(ids.signoff_a!);
    expect(r.signoffs.B?.id).toBe(ids.signoff_b!);
    expect(r.final).toEqual({ id: ids.plan_final!, planHash: r.planHash! });
    expect(r.stored).toEqual({ A: r.planHash!, B: r.planHash! });
    expect(r.rejectedHashes).toHaveLength(1);
    expect(r.proposals).toBe(3);
    expect(r.pending).toBeNull();
    expect(r.awaitingHuman).toEqual({ A: false, B: false });
    expect(r.checkpoints['cp-a-1']).toEqual({ party: 'A', askedIn: ids.ask_a!, answeredIn: ids.answer_a! });
    expect(r.checkpoints['cp-b-1']).toEqual({ party: 'B', askedIn: ids.ask_b!, answeredIn: ids.answer_b! });
    expect(r.lastSeq).toEqual({ A: 11, B: 9 });
    expect(r.lastId).toEqual({ A: ids.bye_a!, B: ids.bye_b! });
  });

  test('AC1: the breaking-change proposal is pending with kind breaking_change', () => {
    const { t } = workedTranscript('propose_breaking');
    expect(t.state().pending?.kinds).toEqual(['breaking_change']);
    expect(t.state().state).toBe('PROPOSAL_PENDING');
  });

  test('AC2: replaying the transcript twice gives identical hashes and deep-equal results', () => {
    const { t } = workedTranscript();
    const first = replay(t.log, opts);
    const second = replay(t.log, opts);

    expect(second).toEqual(first);
    expect(second.planHash).toBe(first.planHash!);
    expect(markdownHash(second.plan!)).toBe(markdownHash(first.plan!));
  });

  test('AC2: a shuffled log with relay_seq replays to the same result', () => {
    const { t } = workedTranscript();
    const ordered = replay(t.log, opts);
    const mixed = shuffled(t.log);

    expect(mixed.map((e) => e.id)).not.toEqual(t.log.map((e) => e.id));
    const result = replay(mixed, opts);
    expect(result).toEqual(ordered);
    expect(result.planHash).toBe(ordered.planHash!);
    expect(markdownHash(result.plan!)).toBe(markdownHash(ordered.plan!));
  });

  test('AC2: without relay_seq the given order is kept', () => {
    const { t } = workedTranscript();
    const unstamped = t.log.map(({ relay_seq: _seq, ...rest }) => rest as Envelope);
    expect(replay(unstamped, opts)).toEqual(replay(t.log, opts));
    expect(replay([...unstamped].reverse(), opts).state).not.toBe('CLOSED');
  });

  test('AC11: validateNext agrees with replay for every message of the worked transcript', () => {
    const { t } = workedTranscript();
    t.log.forEach((env, i) => {
      const prefix = t.log.slice(0, i);
      expect(validateNext(replay(prefix, opts), env, opts)).toEqual({ ok: true });
      expect(expectAgreement(prefix, env, opts)).toBe('accepted');
    });
  });

  test('AC11: validateNext does not modify the result it is given', () => {
    const { t } = workedTranscript('accept_breaking');
    const { t: full } = workedTranscript();
    const r = t.state();
    const snapshot = structuredClone(r);
    validateNext(r, full.log[t.log.length]!, opts);
    expect(r).toEqual(snapshot);
  });
});
