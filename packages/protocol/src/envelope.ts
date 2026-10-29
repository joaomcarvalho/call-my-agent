import { z } from 'zod';
import { canonicalBytes, sha256Hash } from './canonical.ts';
import { signBytes, verifyBytes } from './keys.ts';
import type { Envelope, UnsignedEnvelope } from './types.ts';
import { PROTOCOL_VERSION } from './types.ts';

const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const keyId = z.string().regex(/^ed25519:[0-9a-f]{64}$/);
const party = z.enum(['A', 'B']);

export const MESSAGE_TYPES = [
  'session_open',
  'hello',
  'welcome',
  'say',
  'propose',
  'amend',
  'withdraw',
  'accept',
  'reject',
  'counter',
  'ask_user_pending',
  'user_answer_summary',
  'request_signoff',
  'unfreeze',
  'signoff',
  'plan_final',
  'resolve',
  'heartbeat',
  'error',
  'abort',
  'bye',
] as const;

/** Structural check of an envelope. Body shapes are checked by the state machine. */
export const EnvelopeSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    id: hash,
    session: z.string().min(1).max(128),
    from: z
      .object({
        party,
        agent_key: keyId,
        human: z.string().min(1).max(256),
        org: z.string().max(256).optional(),
      })
      .strict(),
    to: z.array(party),
    seq: z.number().int().positive(),
    prev: hash.nullable(),
    ack: z.object({ A: z.number().int().nonnegative().optional(), B: z.number().int().nonnegative().optional() }).strict(),
    ts: z.string().datetime(),
    type: z.enum(MESSAGE_TYPES),
    reply_to: hash.optional(),
    floor: z.enum(['hold', 'yield']).optional(),
    plan_ref: z.object({ version: z.number().int().nonnegative(), hash }).strict().optional(),
    meter: z
      .object({
        turn: z.number().int().nonnegative(),
        turn_budget: z.number().int().nonnegative(),
        proposals: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    body: z.record(z.string(), z.unknown()),
    sig: z.object({ alg: z.literal('Ed25519'), kid: keyId, value: z.string().min(1) }).strict(),
    relay_seq: z.number().int().nonnegative().optional(),
  })
  .strict();

/** The bytes that are hashed into `id` and signed: JCS of the envelope without id, sig and relay_seq. */
export function signingBytes(envelope: UnsignedEnvelope | Envelope): Uint8Array {
  const { id: _id, sig: _sig, relay_seq: _relaySeq, ...unsigned } = envelope as Envelope;
  return canonicalBytes(unsigned);
}

export function signEnvelope<B>(unsigned: UnsignedEnvelope<B>, secretKey: Uint8Array): Envelope<B> {
  const bytes = signingBytes(unsigned as UnsignedEnvelope);
  return {
    ...unsigned,
    id: sha256Hash(bytes),
    sig: { alg: 'Ed25519', kid: unsigned.from.agent_key, value: signBytes(bytes, secretKey) },
  };
}

export type VerifyResult = { ok: true; envelope: Envelope } | { ok: false; code: 'BAD_SCHEMA' | 'BAD_ID' | 'BAD_SIGNATURE'; detail: string };

/** Schema, id and signature check. Does not check the hash chain or the sender's membership. */
export function verifyEnvelope(input: unknown): VerifyResult {
  const parsed = EnvelopeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'BAD_SCHEMA', detail: parsed.error.message };
  const envelope = parsed.data as Envelope;
  const bytes = signingBytes(envelope);
  if (sha256Hash(bytes) !== envelope.id) return { ok: false, code: 'BAD_ID', detail: 'id does not match signing bytes' };
  if (envelope.sig.kid !== envelope.from.agent_key) {
    return { ok: false, code: 'BAD_SIGNATURE', detail: 'sig.kid differs from from.agent_key' };
  }
  if (!verifyBytes(bytes, envelope.sig.value, envelope.sig.kid)) {
    return { ok: false, code: 'BAD_SIGNATURE', detail: 'signature does not verify' };
  }
  return { ok: true, envelope };
}
