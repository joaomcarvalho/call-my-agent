# T9 · Disclosure hook hardening (security review findings 6, 7)

**Owns:** `plugin/hooks/**`, `plugin/test/hooks.test.ts`.

PoCs: the reviewer's PoC file `review/hooks-relay.poc.test.ts` (kept outside the repo) (the "fail-open" and "scan bypasses" tests). Port them into `plugin/test/hooks.test.ts` asserting the safe behaviour.

## Decisions

1. **Fail closed.** `disclosure.ts` main body is wrapped so any exception exits 2 with a reason. Input traversal is iterative; inputs deeper than 64 or with more than 20 000 nodes are blocked.
2. **Normalize, then scan the whole input.** Collect every string, number and object key in the tool input, NFKC-normalize, strip format characters (U+200B–U+200F, U+202A–U+202E, U+2060–U+2069, U+FEFF), and scan each value and also the concatenation of all values joined with `\n` and joined with `""`.
3. **Hex is not exempt** from the entropy rule when it is ≥ 40 chars and not a `sha256:`-prefixed hash or a 64-hex value that appears as a plan/envelope hash field (`hash`, `result_hash`, `checkpoint_ref`, `proposal`, `sha256`, `charter_hash`). Long digit runs (≥ 24 digits) are flagged.
4. **Matcher covers every tool that sends text to the peer:** `cma_say`, `cma_propose`, `cma_respond`, `cma_answer_checkpoint`, `cma_checkpoint`, `cma_hangup`, `cma_start_call`.

## Acceptance criteria

- **AC1** Each PoC in the fail-open and scan-bypasses tests has a ported test that passes (the hook blocks).
- **AC2** The existing allow cases still pass (normal prose with `path:line`, an OpenAPI snippet, a JSON Patch with sha256 hashes and a `checkpoint_ref`).
- **AC3** `hooks.json` matcher matches all seven tools and nothing else (test the regex against the full tool names `mcp__plugin_call-my-agent_cma__<tool>` for all §4.3 tools).
- **AC4** `bun run check` passes.
