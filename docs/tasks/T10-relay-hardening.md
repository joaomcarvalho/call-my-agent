# T10 · Relay hardening (security review findings 10, 12c)

**Owns:** `packages/relay/**`.

PoCs: `/private/tmp/claude-501/-Users-joaom-workspace/a41030d1-5f67-484d-adbf-486ee169fa35/scratchpad/review/hooks-relay.poc.test.ts` (the relay tests). Port them into `packages/relay/test/` asserting the safe behaviour. Keep the existing client API source-compatible: new parameters are optional.

## Decisions (update implementation-spec §3 to match)

1. **Seat resume needs key possession.** First join of a key needs only the secret (unchanged). Joining with a key that is already a member of the room requires `proof`: base64url Ed25519 signature by that key over the UTF-8 string `cma-relay-resume|<room>|<ts>` plus `ts` (ISO, within ±5 minutes of the server clock). Missing/invalid → 403. The creator key can likewise resume via `POST /v1/rooms/:room/resume {member_key, ts, proof}` without the secret. `RelayClient.joinRoom` gains optional `sign(bytes) => base64url`; add `RelayClient.resumeSeat(relayUrl, room, {memberKey, sign})`.
2. **Abuse limits.** Room creation: max 20 per minute per client IP (429). Per room: max 2 000 messages and 50 MB of payload total (`error ROOM_FULL`). `sync` returns at most 500 messages per call followed by `synced` with `head` and `more: true`; the client keeps syncing until `more` is false. Rate-limit bookkeeping is pruned (no unbounded maps).
3. Use Ed25519 verify from `@cma/protocol` (`verifyBytes`, `isKeyId`).

## Acceptance criteria

- **AC1** The seat-takeover PoC now fails to take the seat (403) and the original token keeps working.
- **AC2** A legitimate resume with a valid proof succeeds and invalidates the old token; a proof older than 5 minutes → 403; a proof by another key → 403.
- **AC3** The 21st room creation within a minute from one IP → 429.
- **AC4** Room message cap → `ROOM_FULL`; sync of 1 200 messages arrives in 3 pages and the client ends with all 1 200 in order.
- **AC5** All existing relay tests still pass unchanged (API compatibility).
- **AC6** `bun run check` passes; run the relay tests 3× for flakiness.
