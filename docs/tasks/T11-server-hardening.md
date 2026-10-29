# T11 · Plugin server hardening (second security review, F1–F3, F5–F7)

**Owns:** `plugin/server/**`, `plugin/test/**` (except `hooks.test.ts`), `packages/relay/**`, `bin/cma.ts` (only the `session` command), `test/cli.test.ts` (only session tests), implementation-spec §3–§4.

PoCs: the reviewer's PoC file `review2/poc.test.ts` (kept outside the repo) (F1–F8). Port the relevant ones into repo tests asserting the safe behaviour.

## Decisions

1. **One owner per call, only in call sessions (F1).**
   - `cma session` exports `CMA_CALL_SESSION=1` (in `--exec` and in the printed command).
   - A server without it starts, lists tools, and answers every tool with a fixed error explaining how to start a call session (`cma session <dir> --exec`). It attaches no calls and never injects.
   - A server with it takes an exclusive lock `<root>/calls/<session>/owner.lock` (pid + start time; stale if the pid is dead) before attaching a call. Locked calls held by another live process are skipped and reported as `UNKNOWN_CALL` with "owned by another session".
   - `CallManager` gets an option to bypass the env check for tests; the lock is never bypassed.
2. **Resume proofs bound to the room secret (F2).**
   - The proof string becomes `cma-relay-resume|<room>|<secret_hash hex>|<ts>`. The relay checks it against its stored secret hash.
   - The client sends no proof on a first join.
   - The server only resumes against the relay URL recorded in `call.json` or the pending-join record, never a different one.
3. **Inspect output is bounded and fenced (F3).** Refuse an invite whose charter has more than 20 share-set entries, an entry over 200 chars, a topic over 200 chars or an invitee label over 100 chars (`BAD_INVITE`). Return topic, inviter human/org, invitee label and share set inside `<counterparty_data>`.
4. **No wake floods (F5).**
   - Control messages (`error`, `ask_user_pending`, `user_answer_summary`, `heartbeat`, `bye`) never trigger a socket injection on their own; they ride along with the next floor message or `cma_wait`.
   - After 10 consecutive peer messages without a floor message, stop injecting until a floor message arrives (still queued for `cma_wait`).
5. **Relay text never reaches the model (F6).** Map relay HTTP/WS failures to fixed strings (`relay refused the request (HTTP <status>)`, `relay error <CODE>` where CODE matches `^[A-Z_]{1,32}$` else `UNKNOWN`). Raw text goes to `audit.jsonl` only.
6. **Agreement files never overwrite (F7).** Write with `wx`; if the file exists and is byte-identical, succeed; otherwise write `<date>-<slug>-<first 8 of session>.md` (also `wx`).

## Acceptance criteria

- **AC1** Each PoC F1, F3, F5, F6, F8 has a ported test that passes; F7 has a new test.
- **AC2** Two managers on one home: only the first owns the call; the second reports it owned; killing the first (stale lock) lets the second take over.
- **AC3** A server without `CMA_CALL_SESSION` returns the fixed error for `cma_start_call` and attaches nothing.
- **AC4** The proof replay attack from F8 against the real relay → 403.
- **AC5** All existing tests pass (update existing tests only where a decision above changes behaviour; list them).
- **AC6** `bun run check` passes; plugin and relay tests 3× without flakes.
