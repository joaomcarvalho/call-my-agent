import { expect } from 'bun:test';
import { replay, validateNext, type ReplayOptions, type ReplayResult } from '../../src/state.ts';
import type { Envelope, ErrorCode } from '../../src/types.ts';
import type { Transcript } from './transcript.ts';

export type Outcome = 'accepted' | 'ignored' | ErrorCode;

export interface Delivery {
  outcome: Outcome;
  before: ReplayResult;
  after: ReplayResult;
  env: Envelope;
}

/** What replay did with the message that turned `before` into `after`. */
function outcomeBetween(before: ReplayResult, after: ReplayResult): Outcome {
  if (after.accepted.length > before.accepted.length) return 'accepted';
  if (after.rejected.length > before.rejected.length) return after.rejected.at(-1)!.code;
  return 'ignored';
}

function expectVerdictMatches(verdict: ReturnType<typeof validateNext>, outcome: Outcome, after: ReplayResult): void {
  if (outcome === 'accepted') {
    expect(verdict).toEqual({ ok: true });
    return;
  }
  expect(verdict.ok).toBe(false);
  if (outcome !== 'ignored') expect(verdict).toEqual({ ok: false, code: outcome, detail: after.rejected.at(-1)!.detail });
}

/** Asserts validateNext(replay(log), env) agrees with replaying `log` followed by `env`; returns what replay did. */
export function expectAgreement(log: Envelope[], env: Envelope, opts: ReplayOptions = {}): Outcome {
  const before = replay(log, opts);
  const after = replay([...log, env], opts);
  const outcome = outcomeBetween(before, after);
  expectVerdictMatches(validateNext(before, env, opts), outcome, after);
  return outcome;
}

/** Appends `env` to the transcript, asserting validateNext predicted what replay did with it. */
export function deliver(t: Transcript, env: Envelope): Delivery {
  const before = t.state();
  const verdict = validateNext(before, env, t.opts);
  const stamped = t.push(env);
  const after = t.state();
  const outcome = outcomeBetween(before, after);
  expectVerdictMatches(verdict, outcome, after);
  return { outcome, before, after, env: stamped };
}

export function expectAccepted(t: Transcript, env: Envelope): Delivery {
  const delivery = deliver(t, env);
  expect(delivery.outcome).toBe('accepted');
  return delivery;
}

export function expectRejected(t: Transcript, env: Envelope, code: ErrorCode): Delivery {
  const delivery = deliver(t, env);
  expect(delivery.outcome).toBe(code);
  return delivery;
}

/** The result without its rejection log, for "state did not change" comparisons. */
export function withoutRejections(r: ReplayResult): Omit<ReplayResult, 'rejected'> {
  const { rejected: _rejected, ...rest } = r;
  return rest;
}
