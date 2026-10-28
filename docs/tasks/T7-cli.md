# T7 · `cma` CLI

**Owns:** `bin/**`, `test/cli.test.ts`.

**Spec:** implementation-spec §4.1, §4.4, §4.5. Reuse `plugin/server/store.ts` for paths and `@cma/protocol` for replay, rendering, `createSignoff`, `renderAgreementFile`, `verifyAgreementFile`. Do not modify them.

## Commands (`bin/cma` is a `#!/usr/bin/env bun` script; logic in `bin/cma.ts`)

- `cma keygen [--human <email>]` — create the identity if missing (agent.key, human.key, human.pub, profile.json); print both key fingerprints. Never overwrite an existing key.
- `cma approve <session|CMA-code> [--decline] [--yes-i-read-it <6 hex>]` — find the call (by session id or display code), replay its log, require state `FROZEN`, print the rendered plan, plan hash and md hash, then require the human to type the first 6 hex chars of the md hash (or pass them with `--yes-i-read-it` for scripting). Sign with `identity/human.key`, write `signoff.json`. Refuses when stdin is not a TTY and the flag is missing.
- `cma verify <file.md>` — `verifyAgreementFile`; exit 0 and print the signers, else exit 1 and the reason.
- `cma relay [--port 8787] [--db path] [--host 127.0.0.1]` — run the relay.
- `cma session [dir]` — generate `<CMA root>/session-settings.json` from `plugin/profiles/call.json` plus `Read(<resolved CMA root>/**)` in `deny` (the whole root: keys, call.json secrets, session-env.json; absolute path with the `//` prefix the permissions docs require), then print (and with `--exec`, run with `CMA_HOME` exported) the command that starts a locked call session in `dir`: `claude --settings <generated file> --plugin-dir <plugin>`. Refuse `--exec` if `--dangerously-skip-permissions` or `--permission-mode` is passed through.
- `cma calls` — list calls with code, peer, state, version.
- Global `--home <dir>` overrides `CMA_HOME`.

## Acceptance criteria

- **AC1** `keygen` twice keeps the same keys; files are mode 0600.
- **AC2** `approve` on a call that is not `FROZEN` exits 1 with the state in the message.
- **AC3** `approve` with the wrong 6 hex chars exits 1 and writes nothing; with the right ones writes a `signoff.json` that `verifySignoff`/the replay accepts.
- **AC4** `verify` on a valid agreement file exits 0; flipping one character in the body, in the embedded JSON, or in a signature each exits 1 with distinct reasons.
- **AC5** `approve` without a TTY and without `--yes-i-read-it` exits 1.
- **AC6** Tests run the CLI as a subprocess (`Bun.spawn`) against temp homes and a fixture call log built with the protocol transcript builder or the plugin's CallManager.
- **AC7** `cma session --home <tmp>` writes a settings file whose `deny` contains `Read(//<tmp>/**)` and every deny rule of the base profile.
- **AC8** `cma verify` accepts `--expect A=<key> --expect B=<key>` and passes them to `verifyAgreementFile`.
- **AC9** `bun run check` passes.
