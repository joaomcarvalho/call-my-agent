import canonicalize from 'canonicalize';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Hash } from './types.ts';

const encoder = new TextEncoder();

/** RFC 8785 (JCS) canonical UTF-8 bytes of a JSON value. Throws on undefined/functions/NaN. */
export function canonicalBytes(value: unknown): Uint8Array {
  const text = canonicalize(value);
  if (text === undefined) throw new Error('value is not canonicalizable');
  return encoder.encode(text);
}

export function canonicalString(value: unknown): string {
  const text = canonicalize(value);
  if (text === undefined) throw new Error('value is not canonicalizable');
  return text;
}

export function sha256Hash(data: Uint8Array | string): Hash {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return `sha256:${bytesToHex(sha256(bytes))}`;
}

/** sha256 over the JCS bytes of a JSON value. */
export function hashObject(value: unknown): Hash {
  return sha256Hash(canonicalBytes(value));
}

export function isHash(value: unknown): value is Hash {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function base64urlDecode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

export { bytesToHex, hexToBytes };
