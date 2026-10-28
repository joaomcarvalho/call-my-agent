import { describe, expect, test } from 'bun:test';
import { generateSigningKey, hashObject, signEnvelope, verifyEnvelope, type UnsignedEnvelope } from '../src/index.ts';

function unsigned(agentKey: `ed25519:${string}`): UnsignedEnvelope {
  return {
    v: 'cma/0.1',
    session: 'ses_test',
    from: { party: 'A', agent_key: agentKey, human: 'alice@example.com' },
    to: ['B'],
    seq: 1,
    prev: null,
    ack: {},
    ts: '2026-10-28T14:02:11.000Z',
    type: 'say',
    body: { text: 'hello' },
  };
}

describe('envelope', () => {
  test('signed envelope verifies', () => {
    const key = generateSigningKey();
    const env = signEnvelope(unsigned(key.keyId), key.secretKey);
    expect(verifyEnvelope(env).ok).toBe(true);
  });

  test('relay_seq is not covered by the signature', () => {
    const key = generateSigningKey();
    const env = signEnvelope(unsigned(key.keyId), key.secretKey);
    expect(verifyEnvelope({ ...env, relay_seq: 42 }).ok).toBe(true);
  });

  test('tampered body is rejected with BAD_ID', () => {
    const key = generateSigningKey();
    const env = signEnvelope(unsigned(key.keyId), key.secretKey);
    const result = verifyEnvelope({ ...env, body: { text: 'hellO' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('BAD_ID');
  });

  test('re-signed by another key is rejected', () => {
    const key = generateSigningKey();
    const other = generateSigningKey();
    const env = signEnvelope(unsigned(key.keyId), other.secretKey);
    const result = verifyEnvelope(env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('BAD_SIGNATURE');
  });

  test('key order does not change the id', () => {
    expect(hashObject({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashObject({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });

  test('unknown top-level fields are rejected', () => {
    const key = generateSigningKey();
    const env = signEnvelope(unsigned(key.keyId), key.secretKey);
    expect(verifyEnvelope({ ...env, extra: 1 }).ok).toBe(false);
  });
});
