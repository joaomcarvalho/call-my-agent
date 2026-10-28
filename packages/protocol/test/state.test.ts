import { describe, expect, test } from 'bun:test';
import { sha256Hash } from '../src/canonical.ts';
import { planHash } from '../src/plan.ts';
import { replay, validateNext } from '../src/state.ts';
import type { Decision, Envelope, JsonPatchOp } from '../src/types.ts';
import { deliver, expectAccepted, expectAgreement, expectRejected, withoutRejections, type Outcome } from './fixtures/deliver.ts';
import {
  EXPIRES_AT,
  KEYS,
  Transcript,
  breakingPatch,
  cursorPatch,
  fixtureCharter,
  versionTest,
  workedTranscript,
  type WorkedStep,
} from './fixtures/transcript.ts';

const at = (step: WorkedStep) => workedTranscript(step);

function decision(id: string, decided_by: Decision['decided_by']): Decision {
  return { id, text: `decision ${id}`, decided_by, decided_in: null };
}

function contextPatch(version: number, text: string): JsonPatchOp[] {
  return [versionTest(version), { op: 'replace', path: '/sections/0/md', value: text }];
}

/** B proposes, then three counters in a row. */
function counterDeadlock(): Transcript {
  const { t } = at('say');
  expectAccepted(t, t.propose('B', contextPatch(0, 'one')));
  expectAccepted(t, t.counter('A', contextPatch(0, 'two')));
  expectAccepted(t, t.counter('B', contextPatch(0, 'three')));
  expectAccepted(t, t.counter('A', contextPatch(0, 'four')));
  return t;
}

interface Scenario {
  t: Transcript;
  env: Envelope;
  expect: Outcome;
}

const SCENARIOS: Record<string, () => Scenario> = {
  'modified body re-signed by a non-member': () => {
    const { t } = at('welcome');
    return { t, env: t.say('A', 'tampered', { signer: KEYS.outsider }), expect: 'UNKNOWN_SENDER' };
  },
  'modified body not re-signed': () => {
    const { t } = at('welcome');
    return { t, env: { ...t.say('A', 'original'), body: { text: 'tampered' } }, expect: 'BAD_ID' };
  },
  'seq too high': () => {
    const { t } = at('welcome');
    return { t, env: t.say('A', 'skipping', { seq: t.state().lastSeq.A + 2 }), expect: 'CHAIN_GAP' };
  },
  'seq already used with a different id': () => {
    const { t } = at('welcome');
    return { t, env: t.say('A', 'again', { seq: t.state().lastSeq.A }), expect: 'CHAIN_DUPLICATE' };
  },
  'prev is not the previous id': () => {
    const { t } = at('welcome');
    return { t, env: t.say('A', 'forked', { prev: t.state().lastId.B }), expect: 'CHAIN_FORK' };
  },
  'exact duplicate id': () => {
    const { t } = at('say');
    return { t, env: t.log[3]!, expect: 'ignored' };
  },
  'say without the floor': () => {
    const { t } = at('welcome');
    return { t, env: t.say('B', 'out of turn'), expect: 'NOT_YOUR_FLOOR' };
  },
  'amend by the non-proposer': () => {
    const { t } = at('propose');
    return { t, env: t.amend('A', contextPatch(0, 'hijacked')), expect: 'INVALID_STATE' };
  },
  'withdraw by the non-proposer': () => {
    const { t } = at('propose');
    return { t, env: t.withdraw('A'), expect: 'INVALID_STATE' };
  },
  'patch without a version test': () => {
    const { t } = at('welcome');
    return { t, env: t.propose('A', contextPatch(0, 'x').slice(1)), expect: 'BAD_PATCH' };
  },
  'patch testing the wrong version': () => {
    const { t } = at('welcome');
    return { t, env: t.propose('A', contextPatch(3, 'x')), expect: 'STALE_BASE' };
  },
  'patch touching /meta/parties': () => {
    const { t } = at('welcome');
    return { t, env: t.propose('A', [versionTest(0), { op: 'replace', path: '/meta/parties/B', value: 'mallory' }]), expect: 'BAD_PATCH' };
  },
  'B editing a.impl_notes': () => {
    const { t } = at('say');
    return { t, env: t.propose('B', [versionTest(0), { op: 'replace', path: '/sections/2/md', value: 'B writes here' }]), expect: 'OWNER_VIOLATION' };
  },
  'second propose while one is pending': () => {
    const { t } = at('propose');
    return { t, env: t.propose('A', contextPatch(0, 'mine instead')), expect: 'PROPOSAL_PENDING' };
  },
  're-proposing a rejected result': () => {
    const { t } = at('propose');
    expectAccepted(t, t.reject('A'));
    return { t, env: t.propose('B', cursorPatch()), expect: 'RECREATES_REJECTED' };
  },
  'countering with the countered result': () => {
    const { t } = at('say');
    expectAccepted(t, t.propose('B', contextPatch(0, 'same')));
    return { t, env: t.counter('A', contextPatch(0, 'same')), expect: 'RECREATES_REJECTED' };
  },
  'A attributing a decision to human-B': () => {
    const { t } = at('welcome');
    return { t, env: t.propose('A', [versionTest(0), { op: 'add', path: '/decisions/-', value: decision('D9', 'human-B') }]), expect: 'OWNER_VIOLATION' };
  },
  'accept with the wrong result_hash': () => {
    const { t } = at('propose');
    return { t, env: t.accept('A', { result_hash: planHash(t.plan) }), expect: 'STALE_BASE' };
  },
  'proposal over budget': () => {
    const { t } = workedTranscript('say', fixtureCharter({ proposals: 1 }));
    expectAccepted(t, t.propose('B', contextPatch(0, 'one')));
    expectAccepted(t, t.reject('A'));
    return { t, env: t.propose('B', contextPatch(0, 'two')), expect: 'BUDGET_EXHAUSTED' };
  },
  'breaking change proposed without checkpoint_ref': () => {
    const { t, ids } = at('answer_a');
    return { t, env: t.propose('A', breakingPatch(ids.accept_counter!), { kinds: ['breaking_change'] }), expect: 'CHECKPOINT_SKIPPED' };
  },
  'checkpoint kind added by the patch but not declared': () => {
    const { t, ids } = at('accept_counter');
    return { t, env: t.propose('A', breakingPatch(ids.accept_counter!), { kinds: [] }), expect: 'CHECKPOINT_SKIPPED' };
  },
  'checkpoint kind set on an existing decision': () => {
    const { t } = at('accept_counter');
    return { t, env: t.propose('A', [versionTest(1), { op: 'add', path: '/decisions/0/kind', value: 'security_or_pii' }]), expect: 'CHECKPOINT_SKIPPED' };
  },
  'checkpoint_ref naming the peer answer': () => {
    const { t, ids } = at('accept_counter');
    expectAccepted(t, t.ask('B', 'cp-b-0'));
    const answer = expectAccepted(t, t.answer('B', 'cp-b-0')).env;
    return { t, env: t.propose('A', breakingPatch(ids.accept_counter!), { checkpoint_ref: answer.id }), expect: 'CHECKPOINT_SKIPPED' };
  },
  'accept with a checkpoint_ref older than the proposal': () => {
    const { t, ids } = at('answer_a');
    expectAccepted(t, t.ask('B', 'cp-b-early'));
    const early = expectAccepted(t, t.answer('B', 'cp-b-early')).env;
    expectAccepted(t, t.propose('A', breakingPatch(ids.accept_counter!), { kinds: ['breaking_change'], checkpoint_ref: ids.answer_a! }));
    return { t, env: t.accept('B', { checkpoint_ref: early.id }), expect: 'CHECKPOINT_SKIPPED' };
  },
  'accept of a checkpoint kind without checkpoint_ref': () => {
    const { t } = at('answer_b');
    return { t, env: t.accept('B'), expect: 'CHECKPOINT_SKIPPED' };
  },
  'request_signoff with a blocking open item': () => {
    const { t } = at('accept_counter');
    return { t, env: t.requestSignoff('A'), expect: 'INVALID_STATE' };
  },
  'request_signoff with the wrong md_hash': () => {
    const { t } = at('accept_breaking');
    return { t, env: t.requestSignoff('B', { md_hash: sha256Hash('other markdown') }), expect: 'INVALID_STATE' };
  },
  'propose while a signoff request is pending': () => {
    const { t } = at('request_signoff');
    return { t, env: t.propose('A', contextPatch(2, 'late change')), expect: 'INVALID_STATE' };
  },
  'propose while frozen': () => {
    const { t } = at('accept_signoff');
    return { t, env: t.propose('B', contextPatch(2, 'late change')), expect: 'INVALID_STATE' };
  },
  'signoff with the wrong md_hash': () => {
    const { t } = at('accept_signoff');
    return { t, env: t.signoff('A', 'approve', { statement: { md_hash: sha256Hash('other markdown') } }), expect: 'SIGNOFF_MISMATCH' };
  },
  'signoff signed by the agent key': () => {
    const { t } = at('accept_signoff');
    return { t, env: t.signoff('A', 'approve', { signer: KEYS.agentA }), expect: 'SIGNOFF_MISMATCH' };
  },
  'signoff naming the agent key as human_key': () => {
    const { t } = at('accept_signoff');
    return { t, env: t.signoff('A', 'approve', { statement: { human_key: KEYS.agentA.keyId }, signer: KEYS.agentA }), expect: 'SIGNOFF_MISMATCH' };
  },
  'unfreeze after a signoff': () => {
    const { t } = at('signoff_a');
    return { t, env: t.unfreeze('B'), expect: 'INVALID_STATE' };
  },
  'plan_final missing a signoff id': () => {
    const { t, ids } = at('signoff_b');
    return { t, env: t.planFinal('A', [ids.signoff_a!]), expect: 'SIGNOFF_MISMATCH' };
  },
  'bye before plan_final': () => {
    const { t } = at('signoff_b');
    return { t, env: t.bye('A'), expect: 'INVALID_STATE' };
  },
  'floor message while deadlocked': () => {
    const t = counterDeadlock();
    return { t, env: t.say('B', 'still here'), expect: 'INVALID_STATE' };
  },
  'resolve partial': () => {
    const t = counterDeadlock();
    return { t, env: t.resolve('A', 'partial'), expect: 'INVALID_STATE' };
  },
  'accepting your own proposal': () => {
    const { t } = at('propose');
    expectAccepted(t, t.say('A', 'your turn'));
    return { t, env: t.accept('B'), expect: 'INVALID_STATE' };
  },
  'reject naming an unknown proposal': () => {
    const { t } = at('propose');
    return { t, env: t.reject('A', sha256Hash('nothing')), expect: 'NO_SUCH_PROPOSAL' };
  },
  'first message is not session_open': () => {
    const t = new Transcript();
    return { t, env: t.say('A', 'hello?'), expect: 'INVALID_STATE' };
  },
  'B speaking before hello': () => {
    const { t } = at('session_open');
    return { t, env: t.say('B', 'hi'), expect: 'UNKNOWN_SENDER' };
  },
  'hello with a wrong join proof': () => {
    const { t } = at('session_open');
    return { t, env: t.hello({ join_proof: '00'.repeat(32) }), expect: 'JOIN_PROOF_INVALID' };
  },
  'hello for another charter': () => {
    const { t } = at('session_open');
    return { t, env: t.hello({ charter_hash: sha256Hash('another charter') }), expect: 'CHARTER_MISMATCH' };
  },
  'message for another session': () => {
    const { t } = at('welcome');
    return { t, env: t.say('A', 'wrong room', { session: 'ses_other' }), expect: 'CHARTER_MISMATCH' };
  },
  'message after abort': () => {
    const { t } = at('welcome');
    expectAccepted(t, t.abort('B'));
    return { t, env: t.say('A', 'anyone there?'), expect: 'INVALID_STATE' };
  },
};

/** Delivers the scenario's message and checks replay did what the scenario expects. */
function run(name: string): Scenario {
  const scenario = SCENARIOS[name]!();
  expect(deliver(scenario.t, scenario.env).outcome).toBe(scenario.expect);
  return scenario;
}

function unchangedApartFromRejection(name: string): void {
  const s = SCENARIOS[name]!();
  const d = deliver(s.t, s.env);
  expect(d.outcome).toBe(s.expect);
  expect(withoutRejections(d.after)).toEqual(withoutRejections(d.before));
  expect(d.after.rejected).toHaveLength(d.before.rejected.length + 1);
}

describe('AC3: authenticity', () => {
  test('AC3: a modified body re-signed by a non-member is rejected UNKNOWN_SENDER and changes nothing', () => {
    unchangedApartFromRejection('modified body re-signed by a non-member');
  });

  test('AC3: a modified body that was not re-signed is rejected BAD_ID and changes nothing', () => {
    unchangedApartFromRejection('modified body not re-signed');
  });
});

describe('AC4: per-sender hash chain', () => {
  test('AC4: a seq more than one past the last is rejected CHAIN_GAP', () => {
    run('seq too high');
  });

  test('AC4: a used seq with a different id is rejected CHAIN_DUPLICATE', () => {
    run('seq already used with a different id');
  });

  test('AC4: a prev that is not the sender’s last id is rejected CHAIN_FORK', () => {
    run('prev is not the previous id');
  });

  test('AC4: an exact duplicate id is ignored without a rejected entry', () => {
    const { t, env } = SCENARIOS['exact duplicate id']!();
    const before = t.state();
    const d = deliver(t, env);
    expect(d.outcome).toBe('ignored');
    expect(d.after).toEqual(before);
    expect(validateNext(before, env, t.opts).ok).toBe(false);
  });

  test('a re-delivered copy of a rejected message is ignored even once it would fit', () => {
    const { t } = at('welcome');
    const early = expectRejected(t, t.say('B', 'out of turn'), 'NOT_YOUR_FLOOR');
    expectAccepted(t, t.say('A', 'go ahead'));
    const again = deliver(t, early.env);
    expect(again.outcome).toBe('ignored');
    expect(again.after.rejected).toHaveLength(1);
  });

  test('garbage log entries are recorded as rejected, never thrown', () => {
    const { t } = at('welcome');
    const garbage = [null, 42, 'text', {}, { ...t.log[0]!, v: 'cma/9' }] as unknown as Envelope[];
    const r = replay([...t.log.map(({ relay_seq: _seq, ...rest }) => rest as Envelope), ...garbage], t.opts);
    expect(r.state).toBe('DISCUSSING');
    expect(r.rejected.map((x) => x.code)).toEqual(['BAD_SCHEMA', 'BAD_SCHEMA', 'BAD_SCHEMA', 'BAD_SCHEMA', 'BAD_SCHEMA']);
  });

  test('a rejected message does not advance the chain', () => {
    const { t } = at('welcome');
    const bad = expectRejected(t, t.say('B', 'out of turn'), 'NOT_YOUR_FLOOR');
    expect(t.state().lastSeq.B).toBe(bad.before.lastSeq.B);
    expectAccepted(t, t.say('A', 'go ahead'));
    const good = expectAccepted(t, t.say('B', 'thanks'));
    expect(good.env.seq).toBe(bad.env.seq);
    expect(good.env.prev).toBe(bad.env.prev);
  });
});

describe('AC5: floor', () => {
  test('AC5: B saying something on A’s floor is rejected NOT_YOUR_FLOOR', () => {
    run('say without the floor');
  });

  test('AC5: amend by the non-proposer is rejected', () => {
    run('amend by the non-proposer');
  });

  test('AC5: withdraw by the non-proposer is rejected', () => {
    run('withdraw by the non-proposer');
  });

  test('floor messages alternate the floor and count a turn each', () => {
    const { t } = at('welcome');
    expect(t.state().floor).toBe('A');
    expectAccepted(t, t.say('A', 'one'));
    expect(t.state().floor).toBe('B');
    expectAccepted(t, t.propose('B', contextPatch(0, 'two')));
    expect(t.state().floor).toBe('A');
    expect(t.state().turns).toEqual({ A: 1, B: 1 });
  });

  test('the proposer amends and withdraws without the floor and without spending turns', () => {
    const { t } = at('propose');
    const turns = t.state().turns;
    const amended = expectAccepted(t, t.amend('B', contextPatch(0, 'amended')));
    expect(t.state().pending).toMatchObject({ id: amended.env.id, type: 'amend', from: 'B' });
    expect(t.state().floor).toBe('A');
    expectAccepted(t, t.withdraw('B'));
    expect(t.state().state).toBe('DISCUSSING');
    expect(t.state().pending).toBeNull();
    expect(t.state().turns).toEqual(turns);
    expect(t.state().proposals).toBe(2);
  });
});

describe('AC6: proposal rules', () => {
  test('AC6: a patch without the version test is rejected BAD_PATCH', () => {
    run('patch without a version test');
  });

  test('AC6: a patch testing the wrong version is rejected STALE_BASE', () => {
    run('patch testing the wrong version');
  });

  test('AC6: a patch touching /meta/parties is rejected BAD_PATCH', () => {
    run('patch touching /meta/parties');
  });

  test('AC6: B editing a.impl_notes is rejected OWNER_VIOLATION', () => {
    run('B editing a.impl_notes');
  });

  test('AC6: a second propose while one is pending is rejected PROPOSAL_PENDING', () => {
    run('second propose while one is pending');
  });

  test('AC6: re-proposing a rejected result is rejected RECREATES_REJECTED', () => {
    run('re-proposing a rejected result');
  });

  test('AC6: countering with the countered result is rejected RECREATES_REJECTED and leaves it pending', () => {
    const { t } = run('countering with the countered result');
    expect(t.state().pending?.from).toBe('B');
    expect(t.state().rejectedHashes).toEqual([]);
  });

  test('AC6: accept with the wrong result_hash is rejected STALE_BASE', () => {
    run('accept with the wrong result_hash');
  });

  test('AC6: a proposal beyond budgets.proposals is rejected BUDGET_EXHAUSTED', () => {
    run('proposal over budget');
  });

  test('a proposal changes nothing until it is accepted', () => {
    const { t } = at('welcome');
    const v0 = t.state().planHash;
    expectAccepted(t, t.propose('A', contextPatch(0, 'pending text')));
    expect(t.state().planHash).toBe(v0);
    expect(t.state().version).toBe(0);
    expectAccepted(t, t.accept('B'));
    expect(t.state().version).toBe(1);
    expect(t.state().plan?.sections[0]?.md).toBe('pending text');
    expect(t.state().plan?.parent).toBe(v0);
  });
});

describe('decision attribution', () => {
  test('a party cannot attribute a decision to the other human', () => {
    run('A attributing a decision to human-B');
  });

  test('a party may record a decision by its own human', () => {
    const { t } = at('welcome');
    expectAccepted(t, t.propose('A', [versionTest(0), { op: 'add', path: '/decisions/-', value: decision('D9', 'human-A') }]));
  });

  test('the peer may accept a decision attributed to the proposer’s human', () => {
    const { t } = at('welcome');
    expectAccepted(t, t.propose('A', [versionTest(0), { op: 'add', path: '/decisions/-', value: decision('D9', 'human-A') }]));
    expectAccepted(t, t.accept('B'));
    expect(t.state().plan?.decisions).toEqual([decision('D9', 'human-A')]);
  });
});

describe('AC7: computed checkpoints', () => {
  test('AC7: proposing a breaking_change decision without checkpoint_ref is rejected CHECKPOINT_SKIPPED', () => {
    run('breaking change proposed without checkpoint_ref');
  });

  test('AC7: accepting with a checkpoint_ref that predates the proposal is rejected CHECKPOINT_SKIPPED', () => {
    run('accept with a checkpoint_ref older than the proposal');
  });

  test('AC7: a checkpoint kind added by the patch but not declared in kinds is still caught', () => {
    run('checkpoint kind added by the patch but not declared');
  });

  test('a checkpoint kind set on an existing decision is caught', () => {
    run('checkpoint kind set on an existing decision');
  });

  test('a checkpoint_ref must name the sender’s own answer', () => {
    run('checkpoint_ref naming the peer answer');
  });

  test('accepting a checkpoint kind without checkpoint_ref is rejected CHECKPOINT_SKIPPED', () => {
    run('accept of a checkpoint kind without checkpoint_ref');
  });

  test('ask_user_pending sets awaitingHuman until the same party answers', () => {
    const { t } = at('accept_counter');
    expectAccepted(t, t.ask('A', 'cp-1'));
    expect(t.state().awaitingHuman).toEqual({ A: true, B: false });
    expectRejected(t, t.answer('B', 'cp-1'), 'INVALID_STATE');
    expectAccepted(t, t.answer('A', 'cp-1'));
    expect(t.state().awaitingHuman).toEqual({ A: false, B: false });
    expectRejected(t, t.answer('A', 'cp-1'), 'INVALID_STATE');
  });
});

describe('AC8: freeze and sign-off', () => {
  test('AC8: request_signoff with a blocking open item is rejected INVALID_STATE', () => {
    run('request_signoff with a blocking open item');
  });

  test('AC8: propose while frozen is rejected INVALID_STATE', () => {
    run('propose while frozen');
  });

  test('AC8: unfreeze returns to DISCUSSING', () => {
    const { t } = at('accept_signoff');
    expectAccepted(t, t.unfreeze('A'));
    expect(t.state().state).toBe('DISCUSSING');
    expect(t.state().frozen).toBeNull();
    expectAccepted(t, t.propose('B', contextPatch(2, 'one more thing')));
  });

  test('AC8: a signoff with the wrong md_hash is rejected SIGNOFF_MISMATCH', () => {
    run('signoff with the wrong md_hash');
  });

  test('AC8: a signoff signed by the agent key instead of the human key is rejected SIGNOFF_MISMATCH', () => {
    run('signoff signed by the agent key');
    run('signoff naming the agent key as human_key');
  });

  test('AC8: decline voids the other party’s approve', () => {
    const { t } = at('signoff_a');
    expect(t.state().signoffs.A).toBeDefined();
    expectAccepted(t, t.signoff('B', 'decline'));
    expect(t.state().state).toBe('DISCUSSING');
    expect(t.state().signoffs).toEqual({});
    expect(t.state().frozen).toBeNull();

    expectAccepted(t, t.requestSignoff('A'));
    expectAccepted(t, t.accept('B'));
    expectAccepted(t, t.signoff('B'));
    expect(t.state().state).toBe('FROZEN');
    expectAccepted(t, t.signoff('A'));
    expect(t.state().state).toBe('AGREED');
  });

  test('a pending signoff request blocks new proposals', () => {
    run('propose while a signoff request is pending');
  });

  test('request_signoff must carry the rendered md_hash', () => {
    run('request_signoff with the wrong md_hash');
  });

  test('say is allowed while frozen', () => {
    const { t } = at('accept_signoff');
    expectAccepted(t, t.say('B', 'waiting for Bob'));
    expect(t.state().state).toBe('FROZEN');
  });

  test('rejecting a signoff request clears it', () => {
    const { t } = at('request_signoff');
    expectAccepted(t, t.reject('A'));
    expect(t.state().signoffRequest).toBeNull();
    expect(t.state().state).toBe('DISCUSSING');
  });

  test('unfreeze after a signoff is rejected', () => {
    run('unfreeze after a signoff');
  });

  test('plan_final must list both approve signoffs', () => {
    run('plan_final missing a signoff id');
  });

  test('bye before plan_final is rejected', () => {
    run('bye before plan_final');
  });
});

describe('AC9: termination', () => {
  test('AC9: reaching no_progress_nudge sets nudge and no_progress_deadlock deadlocks', () => {
    const { t } = workedTranscript('welcome', fixtureCharter({ no_progress_nudge: 2, no_progress_deadlock: 4 }));
    expectAccepted(t, t.say('A', '1'));
    expect(t.state().nudge).toBe(false);
    expectAccepted(t, t.say('B', '2'));
    expect(t.state()).toMatchObject({ noProgress: 2, nudge: true, state: 'DISCUSSING' });
    expectAccepted(t, t.say('A', '3'));
    expect(t.state().state).toBe('DISCUSSING');
    expectAccepted(t, t.say('B', '4'));
    expect(t.state()).toMatchObject({ noProgress: 4, state: 'DEADLOCKED', deadlockReason: 'NO_PROGRESS' });
  });

  test('AC9: an accepted proposal resets no_progress and the nudge', () => {
    const { t } = workedTranscript('welcome', fixtureCharter({ no_progress_nudge: 2, no_progress_deadlock: 4 }));
    expectAccepted(t, t.say('A', '1'));
    expectAccepted(t, t.propose('B', contextPatch(0, 'progress')));
    expect(t.state().nudge).toBe(true);
    expectAccepted(t, t.accept('A'));
    expect(t.state()).toMatchObject({ noProgress: 0, nudge: false, version: 1 });
  });

  test('AC9: three consecutive counters deadlock the session', () => {
    const t = counterDeadlock();
    expect(t.state()).toMatchObject({ state: 'DEADLOCKED', deadlockReason: 'COUNTER_STREAK', counterStreak: 3 });
  });

  test('AC9: resolve extend returns to DISCUSSING with extended budgets', () => {
    const t = counterDeadlock();
    expectAccepted(t, t.resolve('B', 'extend'));
    expect(t.state()).toMatchObject({
      state: 'DISCUSSING',
      turnBudget: { A: 90, B: 90 },
      noProgress: 0,
      nudge: false,
      counterStreak: 0,
      deadlockReason: null,
      pending: null,
    });
    expectAccepted(t, t.propose('B', contextPatch(0, 'fresh start')));
  });

  test('AC9: exhausting a party’s turns deadlocks with BUDGET_EXHAUSTED', () => {
    const { t } = workedTranscript('welcome', fixtureCharter({ turns_per_party: 2 }));
    expectAccepted(t, t.say('A', '1'));
    expectAccepted(t, t.say('B', '2'));
    expectAccepted(t, t.say('A', '3'));
    expect(t.state()).toMatchObject({ state: 'DEADLOCKED', deadlockReason: 'BUDGET_EXHAUSTED', turns: { A: 2, B: 1 } });
    expectAccepted(t, t.resolve('A', 'extend'));
    expect(t.state().turnBudget).toEqual({ A: 3, B: 3 });
    expectAccepted(t, t.say('B', '4'));
  });

  test('AC9: opts.now past expires_at while INVITED gives EXPIRED', () => {
    const { t } = at('session_open');
    expect(replay(t.log, { ...t.opts, now: '2026-10-31T14:00:00.001Z' }).state).toBe('EXPIRED');
    expect(replay(t.log, { ...t.opts, now: EXPIRES_AT }).state).toBe('INVITED');
    expect(replay(t.log, t.opts).state).toBe('INVITED');
  });

  test('an unanswered invite lives until expires_at rather than created_at + ttl_s', () => {
    const { t } = at('session_open');
    expect(replay(t.log, { ...t.opts, now: '2026-10-29T14:00:00.000Z' }).state).toBe('INVITED');
  });

  test('HANDSHAKE expires at expires_at', () => {
    const { t } = at('hello');
    expect(replay(t.log, { ...t.opts, now: '2026-10-30T14:00:00.000Z' }).state).toBe('HANDSHAKE');
    expect(replay(t.log, { ...t.opts, now: '2026-10-31T14:00:00.001Z' }).state).toBe('EXPIRED');
  });

  test('an open session expires ttl_s after the welcome, not after created_at', () => {
    const { t } = at('hello');
    const welcomedAt = '2026-10-29T00:00:00.000Z';
    expectAccepted(t, t.welcome({ ts: welcomedAt }));
    expect(t.state().welcomedAt).toBe(welcomedAt);
    expect(t.charter.budgets.ttl_s).toBe(7200);
    expect(replay(t.log, { ...t.opts, now: '2026-10-29T01:00:00.000Z' }).state).toBe('DISCUSSING');
    expect(replay(t.log, { ...t.opts, now: '2026-10-29T02:00:00.000Z' }).state).toBe('DISCUSSING');
    expect(replay(t.log, { ...t.opts, now: '2026-10-29T02:00:01.000Z' }).state).toBe('EXPIRED');
  });

  test('a closed session stays CLOSED however late it is replayed', () => {
    const { t } = workedTranscript();
    const late = replay(t.log, { ...t.opts, now: '2027-01-01T00:00:00.000Z' });
    expect(late.state).toBe('CLOSED');
    expect(late.accepted).toHaveLength(t.log.length);
  });

  test('validateNext rejects every message once opts.now is past expiry', () => {
    const { t } = at('welcome');
    const now = new Date(Date.parse(t.state().welcomedAt!) + (t.charter.budgets.ttl_s + 1) * 1000).toISOString();
    const env = t.say('A', 'too late');
    expect(validateNext(replay(t.log, { ...t.opts, now }), env, { ...t.opts, now })).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(validateNext(t.state(), env, { ...t.opts, now })).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(validateNext(t.state(), env, t.opts)).toEqual({ ok: true });
  });

  test('resolve abort ends the session', () => {
    const t = counterDeadlock();
    expectAccepted(t, t.resolve('A', 'abort'));
    expect(t.state().state).toBe('ABORTED');
  });

  test('resolve partial is rejected in cma/0.1', () => {
    run('resolve partial');
  });

  test('floor messages are rejected while deadlocked', () => {
    run('floor message while deadlocked');
  });
});

describe('handshake and lifecycle', () => {
  test('replaying an empty log has no charter', () => {
    const r = replay([]);
    expect(r).toMatchObject({ charter: null, plan: null, accepted: [], rejected: [] });
  });

  test('session_open, hello and welcome move INVITED → HANDSHAKE → DISCUSSING', () => {
    const t = new Transcript();
    expectAccepted(t, t.open());
    expect(t.state()).toMatchObject({ state: 'INVITED', version: 0, floor: null, turnBudget: { A: 60, B: 60 } });
    expectAccepted(t, t.hello());
    expect(t.state().state).toBe('HANDSHAKE');
    expect(t.state().identities.B?.agent_key).toBe(KEYS.agentB.keyId);
    expectAccepted(t, t.welcome());
    expect(t.state()).toMatchObject({ state: 'DISCUSSING', floor: 'A' });
  });

  test('the first message must be session_open', () => {
    run('first message is not session_open');
  });

  test('a session_open whose charter_hash does not match is rejected', () => {
    const t = new Transcript();
    const open = t.open();
    expectRejected(t, t.envelope('A', 'session_open', { ...open.body, charter_hash: sha256Hash('other') }), 'CHARTER_MISMATCH');
  });

  test('B cannot speak before its hello', () => {
    run('B speaking before hello');
  });

  test('hello with a wrong join proof is rejected JOIN_PROOF_INVALID', () => {
    run('hello with a wrong join proof');
  });

  test('without a join secret the join proof is not checked', () => {
    const { t } = at('session_open');
    const env = t.hello({ join_proof: '00'.repeat(32) });
    expect(validateNext(replay(t.log), env)).toEqual({ ok: true });
  });

  test('hello for another charter is rejected CHARTER_MISMATCH', () => {
    run('hello for another charter');
  });

  test('a message for another session is rejected CHARTER_MISMATCH', () => {
    run('message for another session');
  });

  test('abort from B while INVITED declines the invite', () => {
    const { t } = at('session_open');
    expectAccepted(t, t.abort('B'));
    expect(t.state().state).toBe('DECLINED');
  });

  test('abort in an open state aborts the session and nothing follows', () => {
    run('message after abort');
  });

  test('a party cannot accept its own proposal', () => {
    run('accepting your own proposal');
  });

  test('reject must name the pending proposal', () => {
    run('reject naming an unknown proposal');
  });

  test('a rejected proposal joins rejectedHashes and frees the floor holder to propose', () => {
    const { t } = at('propose');
    const pending = t.state().pending!;
    expectAccepted(t, t.reject('A'));
    expect(t.state()).toMatchObject({ state: 'DISCUSSING', pending: null, rejectedHashes: [pending.resultHash], floor: 'B' });
  });
});

describe('AC11: validateNext agrees with replay', () => {
  test('AC11: validateNext agrees with replay for every negative scenario', () => {
    for (const [name, build] of Object.entries(SCENARIOS)) {
      const { t, env, expect: expected } = build();
      const outcome = expectAgreement(t.log, { ...env, relay_seq: t.log.length + 1 }, t.opts);
      expect({ name, outcome }).toEqual({ name, outcome: expected });
    }
  });
});
