import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { base64urlDecode, base64urlEncode, canonicalBytes, canonicalString } from './canonical.ts';
import type { Envelope } from './types.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface X25519KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  publicHex: string;
}

export interface SealedPayload {
  e: 0 | 1;
  n: string;
  c: string;
}

export function generateX25519(): X25519KeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { secretKey, publicKey, publicHex: bytesToHex(publicKey) };
}

/** K0: used for session_open and hello. */
export function deriveBootstrapKey(joinSecret: Uint8Array, session: string): Uint8Array {
  return hkdf(sha256, joinSecret, encoder.encode(session), encoder.encode('cma/0.1 k0'), 32);
}

/** K1: used for every message after hello. */
export function deriveSessionKey(
  mySecret: Uint8Array,
  peerPublicHex: string,
  joinSecret: Uint8Array,
  session: string,
): Uint8Array {
  const shared = x25519.getSharedSecret(mySecret, hexToBytes(peerPublicHex));
  return hkdf(sha256, concatBytes(shared, joinSecret), encoder.encode(session), encoder.encode('cma/0.1 k1'), 32);
}

/** Encrypts the envelope under `key` with the session id as AAD. Returns the JCS string the relay carries. */
export function sealEnvelope(env: Envelope, key: Uint8Array, epoch: 0 | 1): string {
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(key, nonce, encoder.encode(env.session)).encrypt(canonicalBytes(env));
  const payload: SealedPayload = { e: epoch, n: base64urlEncode(nonce), c: base64urlEncode(ciphertext) };
  return canonicalString(payload);
}

/** Decrypts with the key for the payload's epoch. Throws on auth failure, unknown epoch or missing key. */
export function openEnvelope(payload: string, keys: { k0: Uint8Array; k1?: Uint8Array }, session: string): unknown {
  const parsed = JSON.parse(payload) as Partial<SealedPayload>;
  if (typeof parsed.n !== 'string' || typeof parsed.c !== 'string') throw new Error('malformed sealed payload');
  let key: Uint8Array | undefined;
  if (parsed.e === 0) key = keys.k0;
  else if (parsed.e === 1) key = keys.k1;
  else throw new Error(`unknown epoch: ${String(parsed.e)}`);
  if (!key) throw new Error(`no key for epoch ${parsed.e}`);
  const nonce = base64urlDecode(parsed.n);
  if (nonce.length !== 24) throw new Error('bad nonce length');
  const plaintext = xchacha20poly1305(key, nonce, encoder.encode(session)).decrypt(base64urlDecode(parsed.c));
  return JSON.parse(decoder.decode(plaintext));
}
