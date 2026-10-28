import { describe, expect, test } from 'bun:test';
import { base64urlDecode, base64urlEncode } from '../src/canonical.ts';
import {
  deriveBootstrapKey,
  deriveSessionKey,
  generateX25519,
  openEnvelope,
  sealEnvelope,
  type SealedPayload,
} from '../src/e2ee.ts';
import { generateJoinSecret } from '../src/invite.ts';
import { generateSigningKey } from '../src/keys.ts';
import { signEnvelope } from '../src/envelope.ts';
import type { Envelope } from '../src/types.ts';

const SESSION = 'ses_test';
const MARKER = 'ZEBRA-MARKER-7731';

function makeEnvelope(): Envelope {
  const key = generateSigningKey();
  return signEnvelope(
    {
      v: 'cma/0.1',
      session: SESSION,
      from: { party: 'A', agent_key: key.keyId, human: 'alice@example.com' },
      to: ['B'],
      seq: 1,
      prev: null,
      ack: {},
      ts: '2026-10-28T14:02:11.000Z',
      type: 'say',
      body: { text: MARKER },
    },
    key.secretKey,
  );
}

function setup() {
  const secret = generateJoinSecret();
  const a = generateX25519();
  const b = generateX25519();
  return {
    secret,
    a,
    b,
    k0: deriveBootstrapKey(secret, SESSION),
    k1: deriveSessionKey(a.secretKey, b.publicHex, secret, SESSION),
  };
}

function tamper(payload: string, field: 'n' | 'c'): string {
  const parsed = JSON.parse(payload) as SealedPayload;
  const bytes = base64urlDecode(parsed[field]);
  bytes[0] = bytes[0]! ^ 0x01;
  return JSON.stringify({ ...parsed, [field]: base64urlEncode(bytes) });
}

describe('e2ee', () => {
  test('AC1: both parties derive the same K1 and a third party derives a different one', () => {
    const { secret, a, b } = setup();
    const c = generateX25519();
    const ka = deriveSessionKey(a.secretKey, b.publicHex, secret, SESSION);
    const kb = deriveSessionKey(b.secretKey, a.publicHex, secret, SESSION);
    const kc = deriveSessionKey(c.secretKey, a.publicHex, secret, SESSION);
    expect(ka).toEqual(kb);
    expect(kc).not.toEqual(ka);
  });

  test('AC2: open(seal(env)) deep-equals env for epoch 0', () => {
    const { k0, k1 } = setup();
    const env = makeEnvelope();
    expect(openEnvelope(sealEnvelope(env, k0, 0), { k0, k1 }, SESSION)).toEqual(env);
  });

  test('AC2: open(seal(env)) deep-equals env for epoch 1', () => {
    const { k0, k1 } = setup();
    const env = makeEnvelope();
    expect(openEnvelope(sealEnvelope(env, k1, 1), { k0, k1 }, SESSION)).toEqual(env);
  });

  test('AC2: epoch 1 payload cannot be opened without k1', () => {
    const { k0, k1 } = setup();
    expect(() => openEnvelope(sealEnvelope(makeEnvelope(), k1, 1), { k0 }, SESSION)).toThrow();
  });

  test('AC2: unknown epoch throws', () => {
    const { k0, k1 } = setup();
    const parsed = JSON.parse(sealEnvelope(makeEnvelope(), k0, 0)) as SealedPayload;
    expect(() => openEnvelope(JSON.stringify({ ...parsed, e: 2 }), { k0, k1 }, SESSION)).toThrow();
  });

  test('AC3: flipping a ciphertext byte makes open throw', () => {
    const { k0 } = setup();
    expect(() => openEnvelope(tamper(sealEnvelope(makeEnvelope(), k0, 0), 'c'), { k0 }, SESSION)).toThrow();
  });

  test('AC3: flipping a nonce byte makes open throw', () => {
    const { k0 } = setup();
    expect(() => openEnvelope(tamper(sealEnvelope(makeEnvelope(), k0, 0), 'n'), { k0 }, SESSION)).toThrow();
  });

  test('AC3: a different session string makes open throw', () => {
    const { k0 } = setup();
    expect(() => openEnvelope(sealEnvelope(makeEnvelope(), k0, 0), { k0 }, 'ses_other')).toThrow();
  });

  test('AC3: a wrong key makes open throw', () => {
    const { k0, k1 } = setup();
    expect(() => openEnvelope(sealEnvelope(makeEnvelope(), k0, 0), { k0: k1 }, SESSION)).toThrow();
  });

  test('AC4: two seals of the same envelope differ', () => {
    const { k0 } = setup();
    const env = makeEnvelope();
    expect(sealEnvelope(env, k0, 0)).not.toBe(sealEnvelope(env, k0, 0));
  });

  test('AC5: sealed payload does not contain body text or type in plaintext', () => {
    const { k0 } = setup();
    const sealed = sealEnvelope(makeEnvelope(), k0, 0);
    expect(sealed).not.toContain(MARKER);
    expect(sealed).not.toContain('say');
    expect(Object.keys(JSON.parse(sealed)).sort()).toEqual(['c', 'e', 'n']);
  });
});
