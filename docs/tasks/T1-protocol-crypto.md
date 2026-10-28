# T1 · Protocol crypto: E2EE, invites, four-word code

**Owns:** `packages/protocol/src/e2ee.ts`, `packages/protocol/src/invite.ts`, `packages/protocol/src/words.ts`, `packages/protocol/test/e2ee.test.ts`, `packages/protocol/test/invite.test.ts`, `packages/protocol/test/words.test.ts`. Do not edit `index.ts`; import from your own files in tests. The orchestrator adds the exports on merge.

**Spec:** implementation-spec §2.9, §2.10, §2.11. Use only `@noble/curves`, `@noble/hashes`, `@noble/ciphers`, `zod` and the existing helpers in `canonical.ts`/`keys.ts`.

## API to implement

```ts
// e2ee.ts
export interface X25519KeyPair { secretKey: Uint8Array; publicKey: Uint8Array; publicHex: string }
export function generateX25519(): X25519KeyPair
export function deriveBootstrapKey(joinSecret: Uint8Array, session: string): Uint8Array          // K0
export function deriveSessionKey(mySecret: Uint8Array, peerPublicHex: string, joinSecret: Uint8Array, session: string): Uint8Array // K1
export interface SealedPayload { e: 0 | 1; n: string; c: string }
export function sealEnvelope(env: Envelope, key: Uint8Array, epoch: 0 | 1): string   // returns JCS string of SealedPayload
export function openEnvelope(payload: string, keys: { k0: Uint8Array; k1?: Uint8Array }, session: string): unknown // returns parsed envelope JSON; throws on auth failure or unknown epoch

// invite.ts
export interface Invite { v: 1; relay: string; room: string; session: string; secret: string; fp: KeyId; charter_hash: Hash; exp: string }
export function encodeInvite(invite: Invite): string            // "cma1." + base64url(JCS(invite))
export function decodeInvite(text: string): Invite             // zod-validated; throws Error with a clear message
export function inviteCode(room: string): string               // "CMA-XXXX-XXXX"
export function generateJoinSecret(): Uint8Array               // 32 random bytes
export function joinProof(secret: Uint8Array, session: string): string   // hex sha256(secret || utf8(session))
export function secretHash(secret: Uint8Array): string         // hex sha256(secret) — what the relay stores

// words.ts
export const WORDS: readonly string[]                          // exactly 256 distinct lowercase ASCII words, 3–8 letters
export function fourWordCode(a: KeyId, b: KeyId): string       // "word-word-word-word"
```

## Acceptance criteria

- **AC1** Both parties derive the same K1 from their own secret and the other's public key; a third keypair derives a different key.
- **AC2** `openEnvelope(sealEnvelope(env, k, e))` returns a value deep-equal to `env` for epochs 0 and 1.
- **AC3** Flipping any byte of the ciphertext, the nonce, or using a different session string makes `openEnvelope` throw.
- **AC4** Two seals of the same envelope produce different ciphertexts (random nonce).
- **AC5** The sealed payload string contains neither the envelope's `body` text nor its `type` in plaintext (test with a recognisable marker string).
- **AC6** `decodeInvite(encodeInvite(x))` deep-equals `x`; malformed prefix, bad base64, missing field, or a `fp` that isn't a KeyId each throw.
- **AC7** `inviteCode("rabcdefgh12345678")` → `"CMA-ABCD-EFGH"`.
- **AC8** `fourWordCode(a, b) === fourWordCode(b, a)`; changes when either key changes; output matches `/^[a-z]+(-[a-z]+){3}$/`.
- **AC9** `WORDS` has 256 unique entries matching `/^[a-z]{3,8}$/`.
- **AC10** `bun run check` passes.
