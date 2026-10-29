# T12 · Read guard hook for the CMA home (second security review, F4)

**Owns:** `plugin/hooks/read-guard.ts` (new), `plugin/hooks/hooks.json`, `plugin/test/read-guard.test.ts` (new), and `plugin/profiles/call.json` (remove the static identity paths only if the hook makes them redundant — keep them as defense in depth otherwise).

## Decision

A `PreToolUse` hook on `Read`, `Grep`, `Glob` (and `NotebookRead` if present) blocks (exit 2) any call whose path argument (`file_path`, `path`, `pattern` base dir, `glob`) resolves — after `~` expansion, `path.resolve` against the hook input's `cwd`, and `realpath` of the longest existing prefix — to a location inside the CMA root (`plugin/hooks/lib.ts` `cmaRoot()` and its realpath). Grep/Glob with no path use `cwd`; block if `cwd` is inside the root. Fails closed (exit 2) on any error, never exit 1. Iterative, no recursion.

## Acceptance criteria

- **AC1** Blocks: `Read` of `<root>/identity/human.key`; via a symlink pointing into the root; via `..` segments; `Grep` with `path: <root>`; `Glob` with `pattern: "<root>/**"`; Read with `~` when the root is under `$HOME`; root given by `CMA_HOME` and by `CLAUDE_PLUGIN_DATA`.
- **AC2** Allows: reading repo files, a sibling dir whose name starts with the root's name (`<root>-other/x`), Grep/Glob in the repo.
- **AC3** `hooks.json` registers the hook for exactly those tools (anchored matcher), existing hooks untouched; the existing matcher test still passes.
- **AC4** `bun run check` passes.
