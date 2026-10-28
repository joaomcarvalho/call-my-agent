# T5 · Plugin MCP server

**Owns:** `plugin/server/**`, `plugin/test/**`.

**Spec:** implementation-spec §2.9–§2.10, §4.1–§4.5. Builds on `@cma/protocol` (replay, validateNext, applyProposal, renderMarkdown, e2ee, invite, agreement) and `@cma/relay` (RelayClient). Read their sources before starting; do not modify them.

## Structure

```
plugin/server/index.ts        MCP wiring only: McpServer (@modelcontextprotocol/sdk) on stdio, registers the §4.3 tools, maps errors
plugin/server/store.ts        §4.1 layout: resolve root, load-or-create identity (agent.key, human.pub — never reads human.key), call.json, log.jsonl, audit.jsonl
plugin/server/call.ts         CallRuntime: one live call (relay connection, keys, log, replay result, outbound builder, signoff watcher)
plugin/server/manager.ts      CallManager: tool-shaped methods (startCall, inspectInvite, joinCall, say, propose, respond, ...) over CallRuntimes; resumes calls from disk on start
plugin/server/inbox.ts        §4.2 socket delivery + in-memory fallback queue
plugin/server/format.ts       the §4.2 injected text and compact tool results
```

## Behaviour

- **Outbound:** build the envelope from the latest replay (`seq = lastSeq+1`, `prev = lastId`, `ack = lastSeq`), run `validateNext` locally and refuse invalid sends with the protocol code, sign with the agent key, seal (epoch 0 for `session_open`/`hello`, else 1), `RelayClient.send(env.id, payload)`, then resolve the tool call only after the relay echo has been appended and replayed.
- **Inbound:** decrypt → `verifyEnvelope` → append to `log.jsonl` with `relay_seq` → replay. Undecryptable or unverifiable payloads go to the audit log only. Peer messages (not own) are delivered via `inbox.ts`.
- **Start (A):** create identity if needed, charter with `DEFAULT_BUDGETS[mode]`, `checkpoint_kinds = ["breaking_change", "security_or_pii", "deadline_commitment", "ownership_change"]`, `createPlanV0`, join secret, x25519, room, send `session_open`, return invite + code + fingerprint.
- **Join (B):** decode invite, join room, sync, decrypt `session_open` with K0, check `charter.inviter.agent_key === invite.fp` and `charter_hash === invite.charter_hash` (else refuse and abort), send `hello` with `join_proof` and own identity (agent key, human pub key, x25519).
- **A's server auto-replies `welcome`** on a valid `hello`. A's server auto-sends `plan_final` on reaching `AGREED`.
- **Signoff watcher:** poll `<call dir>/signoff.json` every 500 ms while `FROZEN`; validate (statement matches frozen plan and own identity, signature verifies), send as a `signoff` envelope, rename to `signoff.sent.json`. Invalid files are renamed `signoff.rejected.json` with the reason in audit.
- **`cma_write_plan`:** only in `AGREED` with `plan_final` seen; writes `renderAgreementFile(...)` to `<repo_root>/docs/agreements/<name>`, then sends `bye {stored: plan_hash}`. `repo_root` = `CLAUDE_PROJECT_DIR` env, else `process.cwd()`.
- **Persistence:** a restarted server resumes every non-terminal call from `call.json` + `log.jsonl` and reconnects with its cursor.
- Every tool result is compact JSON with `state`, `floor` (`"you"`/`"peer"`), `version`, `awaiting_human`, and `pending_inbound` when non-zero.

## Acceptance criteria

- **AC1** `plugin/test/e2e.test.ts`: a relay (`startRelay({port: 0})`), two `CallManager`s with separate temp `CMA_HOME`s (alice = A, bob = B), and no Claude. Script: start → join → say → propose (cursor pagination) → counter (add total_count) → accept → checkpoint + answer → propose a `breaking_change` decision with checkpoint_ref → peer checkpoint + answer → accept with checkpoint_ref → request_signoff → accept → both signoffs created with `createSignoff` from `@cma/protocol` using each side's human key and written as `signoff.json` → both reach `AGREED` → both `writePlan` into separate temp repo dirs → **the two agreement files are byte-identical** and `verifyAgreementFile` returns ok → both reach `CLOSED`.
- **AC2** The relay's SQLite DB after AC1 contains no plaintext: scan every stored payload for the topic string, the say text, and `"type"` — none found.
- **AC3** Joining with an invite whose `fp` doesn't match the charter's inviter key is refused and nothing is sent.
- **AC4** Restart: stop bob's manager mid-call (after the first `say`), alice sends another `say`, start a new manager on bob's home; it resumes, receives the message, and the call completes.
- **AC5** An invalid outbound action (e.g. `say` without the floor) returns a tool error with `NOT_YOUR_FLOOR` and sends nothing to the relay.
- **AC6** `inbox.ts`: against a fake Unix socket server in the test, delivery writes exactly the auth line then one `{"type":"user","message":{"role":"user","content":...}}` line, batches messages arriving within the window, and falls back to the queue when the socket is missing or refuses. Content wraps peer text in `<counterparty_data>` and escapes any `</counterparty_data>` inside peer text.
- **AC7** A tampered `signoff.json` (wrong md_hash or wrong key) is rejected locally, renamed `signoff.rejected.json`, and never sent.
- **AC8** MCP smoke test: connect an MCP `Client` to the server via `InMemoryTransport.createLinkedPair()`, list tools, assert the exact §4.3 tool set and that no tool name contains `sign` except `cma_request_signoff`.
- **AC9** The server never reads `identity/human.key` (test: make it unreadable with `chmod 000` and run AC1's alice side up to `FROZEN`).
- **AC10** `bun run check` passes; tests clean up temp dirs and close relays.
