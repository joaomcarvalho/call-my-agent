import { describe, expect, test } from 'bun:test';
import { base64urlEncode } from '../src/canonical.ts';
import {
  decodeInvite,
  encodeInvite,
  generateJoinSecret,
  inviteCode,
  joinProof,
  secretHash,
  type Invite,
} from '../src/invite.ts';

const invite: Invite = {
  v: 1,
  relay: 'wss://relay.example.com',
  room: 'rabcdefgh12345678',
  session: 'ses_test',
  secret: base64urlEncode(new Uint8Array(32).fill(7)),
  fp: `ed25519:${'ab'.repeat(32)}`,
  charter_hash: `sha256:${'cd'.repeat(32)}`,
  exp: '2026-10-29T14:02:11.000Z',
};

function encodeRaw(value: unknown): string {
  return `cma1.${base64urlEncode(new TextEncoder().encode(JSON.stringify(value)))}`;
}

describe('invite', () => {
  test('AC6: decode(encode(x)) deep-equals x', () => {
    const text = encodeInvite(invite);
    expect(text.startsWith('cma1.')).toBe(true);
    expect(decodeInvite(text)).toEqual(invite);
  });

  test('AC6: malformed prefix throws', () => {
    expect(() => decodeInvite(encodeInvite(invite).replace('cma1.', 'cma2.'))).toThrow(/cma1/);
  });

  test('AC6: bad base64 throws', () => {
    expect(() => decodeInvite('cma1.!!!not base64!!!')).toThrow(/base64url/);
  });

  test('AC6: non-JSON payload throws', () => {
    expect(() => decodeInvite(`cma1.${base64urlEncode(new TextEncoder().encode('nope'))}`)).toThrow(/JSON/);
  });

  test('AC6: missing field throws', () => {
    const { session: _session, ...rest } = invite;
    expect(() => decodeInvite(encodeRaw(rest))).toThrow(/session/);
  });

  test('AC6: fp that is not a KeyId throws', () => {
    expect(() => decodeInvite(encodeRaw({ ...invite, fp: 'ed25519:abc' }))).toThrow(/fp/);
  });

  test('AC7: inviteCode formats the first eight characters of the room id', () => {
    expect(inviteCode('rabcdefgh12345678')).toBe('CMA-ABCD-EFGH');
  });

  test('join secret is 32 random bytes', () => {
    const a = generateJoinSecret();
    expect(a.length).toBe(32);
    expect(generateJoinSecret()).not.toEqual(a);
  });

  test('joinProof and secretHash are hex sha256 and depend on their inputs', () => {
    const secret = new Uint8Array(32).fill(1);
    expect(joinProof(secret, 's1')).toMatch(/^[0-9a-f]{64}$/);
    expect(joinProof(secret, 's1')).toBe(joinProof(secret, 's1'));
    expect(joinProof(secret, 's1')).not.toBe(joinProof(secret, 's2'));
    expect(secretHash(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(secretHash(secret)).not.toBe(joinProof(secret, 's1'));
  });
});
