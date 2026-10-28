import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base64urlDecode, base64urlEncode, canonicalBytes } from './canonical.ts';
import type { KeyId } from './types.ts';

export interface SigningKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  keyId: KeyId;
}

export function generateSigningKey(): SigningKeyPair {
  return signingKeyFromSecret(ed25519.utils.randomSecretKey());
}

export function signingKeyFromSecret(secretKey: Uint8Array): SigningKeyPair {
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey, keyId: keyIdFromPublic(publicKey) };
}

export function keyIdFromPublic(publicKey: Uint8Array): KeyId {
  return `ed25519:${bytesToHex(publicKey)}`;
}

export function publicFromKeyId(keyId: KeyId | string): Uint8Array {
  const match = /^ed25519:([0-9a-f]{64})$/.exec(keyId);
  if (!match) throw new Error(`malformed key id: ${keyId}`);
  return hexToBytes(match[1]!);
}

export function isKeyId(value: unknown): value is KeyId {
  return typeof value === 'string' && /^ed25519:[0-9a-f]{64}$/.test(value);
}

/** Short human-comparable fingerprint: first 16 hex chars of the key, in groups of 4. */
export function fingerprint(keyId: KeyId): string {
  const hex = keyId.slice('ed25519:'.length, 'ed25519:'.length + 16).toUpperCase();
  return hex.match(/.{4}/g)!.join('-');
}

export function signBytes(bytes: Uint8Array, secretKey: Uint8Array): string {
  return base64urlEncode(ed25519.sign(bytes, secretKey));
}

export function verifyBytes(bytes: Uint8Array, signature: string, keyId: KeyId | string): boolean {
  try {
    return ed25519.verify(base64urlDecode(signature), bytes, publicFromKeyId(keyId));
  } catch {
    return false;
  }
}

/** Sign the JCS bytes of a JSON value. */
export function signObject(value: unknown, secretKey: Uint8Array): string {
  return signBytes(canonicalBytes(value), secretKey);
}

export function verifyObject(value: unknown, signature: string, keyId: KeyId | string): boolean {
  return verifyBytes(canonicalBytes(value), signature, keyId);
}
