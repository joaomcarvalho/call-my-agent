import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, randomBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { base64urlDecode, base64urlEncode, canonicalBytes } from './canonical.ts';
import type { Hash, KeyId } from './types.ts';

const PREFIX = 'cma1.';

export interface Invite {
  v: 1;
  relay: string;
  room: string;
  session: string;
  /** base64url of the 32-byte join secret. */
  secret: string;
  fp: KeyId;
  charter_hash: Hash;
  exp: string;
}

const InviteSchema = z
  .object({
    v: z.literal(1),
    relay: z.string().min(1),
    room: z.string().min(1),
    session: z.string().min(1),
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'must be 32 bytes base64url'),
    fp: z.string().regex(/^ed25519:[0-9a-f]{64}$/, 'must be an ed25519 key id'),
    charter_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be a sha256 hash'),
    exp: z.string().datetime(),
  })
  .strict();

export function encodeInvite(invite: Invite): string {
  return PREFIX + base64urlEncode(canonicalBytes(invite));
}

export function decodeInvite(text: string): Invite {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error(`invite must start with "${PREFIX}"`);
  const body = trimmed.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) throw new Error('invite is not valid base64url');
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64urlDecode(body)));
  } catch {
    throw new Error('invite payload is not valid JSON');
  }
  const parsed = InviteSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`invalid invite: ${issue.path.join('.') || 'payload'}: ${issue.message}`);
  }
  return parsed.data as Invite;
}

/** `CMA-XXXX-XXXX` from the room id; the leading `r` type prefix of room ids is not shown. */
export function inviteCode(room: string): string {
  const chars = room.replace(/^r/, '').slice(0, 8).toUpperCase();
  if (chars.length < 8) throw new Error('room id too short for an invite code');
  return `CMA-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function generateJoinSecret(): Uint8Array {
  return randomBytes(32);
}

/** hex sha256(secret || utf8(session)) */
export function joinProof(secret: Uint8Array, session: string): string {
  return bytesToHex(sha256(concatBytes(secret, new TextEncoder().encode(session))));
}

/** hex sha256(secret): what the relay stores. */
export function secretHash(secret: Uint8Array): string {
  return bytesToHex(sha256(secret));
}
