import { describe, expect, test } from 'bun:test';
import { ChainTracker } from '../src/chain.ts';
import { signEnvelope } from '../src/envelope.ts';
import type { Envelope, Hash, Party } from '../src/types.ts';
import { KEYS } from './fixtures/transcript.ts';

function message(party: Party, seq: number, prev: Hash | null, text = `message ${seq}`): Envelope {
  const key = party === 'A' ? KEYS.agentA : KEYS.agentB;
  return signEnvelope(
    {
      v: 'cma/0.1',
      session: 'ses_chain',
      from: { party, agent_key: key.keyId, human: party },
      to: [party === 'A' ? 'B' : 'A'],
      seq,
      prev,
      ack: {},
      ts: '2026-10-28T14:00:00.000Z',
      type: 'say',
      body: { text },
    },
    key.secretKey,
  );
}

describe('ChainTracker', () => {
  test('each party starts at seq 0 with no previous id', () => {
    const chain = new ChainTracker();
    expect(chain.last('A')).toEqual({ seq: 0, id: null });
    expect(chain.last('B')).toEqual({ seq: 0, id: null });
    expect(chain.check(message('A', 1, null))).toEqual({ ok: true });
  });

  test('commit advances the sender’s head only', () => {
    const chain = new ChainTracker();
    const first = message('A', 1, null);
    chain.commit(first);
    expect(chain.last('A')).toEqual({ seq: 1, id: first.id });
    expect(chain.last('B')).toEqual({ seq: 0, id: null });
    expect(chain.check(message('A', 2, first.id))).toEqual({ ok: true });
    expect(chain.check(message('B', 1, null))).toEqual({ ok: true });
  });

  test('AC4: a seq beyond last + 1 is CHAIN_GAP', () => {
    const chain = new ChainTracker();
    expect(chain.check(message('A', 2, null))).toMatchObject({ ok: false, code: 'CHAIN_GAP' });
  });

  test('AC4: a seq already used with a different id is CHAIN_DUPLICATE', () => {
    const chain = new ChainTracker();
    chain.commit(message('A', 1, null));
    expect(chain.check(message('A', 1, null, 'other text'))).toMatchObject({ ok: false, code: 'CHAIN_DUPLICATE' });
  });

  test('AC4: a prev that is not the sender’s last id is CHAIN_FORK', () => {
    const chain = new ChainTracker();
    const first = message('A', 1, null);
    chain.commit(first);
    const other = message('B', 1, null);
    expect(chain.check(message('A', 2, other.id))).toMatchObject({ ok: false, code: 'CHAIN_FORK' });
    expect(chain.check(message('A', 2, null))).toMatchObject({ ok: false, code: 'CHAIN_FORK' });
  });

  test('commit refuses a message that does not extend the chain', () => {
    const chain = new ChainTracker();
    expect(() => chain.commit(message('A', 2, null))).toThrow('CHAIN_GAP');
    expect(chain.last('A')).toEqual({ seq: 0, id: null });
  });

  test('a tracker resumes from known heads', () => {
    const first = message('B', 1, null);
    const chain = new ChainTracker({ seq: { A: 0, B: 1 }, id: { A: null, B: first.id } });
    expect(chain.check(message('B', 2, first.id))).toEqual({ ok: true });
    expect(chain.check(message('B', 1, null))).toMatchObject({ ok: false, code: 'CHAIN_DUPLICATE' });
  });
});
