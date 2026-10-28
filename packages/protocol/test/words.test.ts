import { describe, expect, test } from 'bun:test';
import { generateSigningKey } from '../src/keys.ts';
import { fourWordCode, WORDS } from '../src/words.ts';

describe('words', () => {
  test('AC8: fourWordCode is symmetric', () => {
    const a = generateSigningKey().keyId;
    const b = generateSigningKey().keyId;
    expect(fourWordCode(a, b)).toBe(fourWordCode(b, a));
  });

  test('AC8: fourWordCode changes when either key changes', () => {
    const a = generateSigningKey().keyId;
    const b = generateSigningKey().keyId;
    const c = generateSigningKey().keyId;
    const base = fourWordCode(a, b);
    expect(fourWordCode(a, c)).not.toBe(base);
    expect(fourWordCode(c, b)).not.toBe(base);
  });

  test('AC8: fourWordCode has four lowercase words joined by dashes', () => {
    const code = fourWordCode(generateSigningKey().keyId, generateSigningKey().keyId);
    expect(code).toMatch(/^[a-z]+(-[a-z]+){3}$/);
  });

  test('AC9: WORDS has 256 unique entries of 3-8 lowercase letters', () => {
    expect(WORDS.length).toBe(256);
    expect(new Set(WORDS).size).toBe(256);
    for (const word of WORDS) expect(word).toMatch(/^[a-z]{3,8}$/);
  });
});
