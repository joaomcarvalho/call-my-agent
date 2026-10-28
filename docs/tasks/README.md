# Task cards

Each card is one agent's job. Read `docs/design/implementation-spec.md` first; it is authoritative. `docs/design/proposal.md` is background.

## Rules for every task

1. **Stay in your paths.** Only create or edit files under the paths your card owns. Anything else is read-only.
2. **Frozen contracts.** Do not edit `packages/protocol/src/{types,canonical,keys,envelope}.ts` or tests you didn't write. If a contract blocks you, stop and report what you need and why. Do not work around it.
3. **No new dependencies** beyond the ones already in the package's `package.json`, unless your card lists them.
4. **Green before done.** `bun run check` from the repo root must pass. Paste the tail of its output in your report.
5. **Commit, don't push.** Commit on your worktree branch with a clear message. Do not push, merge, or rebase main.
6. **Tests prove the AC.** Each acceptance criterion maps to at least one named test. The test names say the behaviour.
7. **No placeholders.** No `TODO`, stubbed functions, or skipped tests in delivered code.
8. **Comments.** Only where a reader would be surprised (spec constraints, external behaviour). No narration.

## Report format

```
Task: <id>
Branch: <branch>   Commit: <sha>
Files: <list>
AC:
- [x] AC1 — test "<name>" (file)
- ...
Check: <tail of bun run check>
Deviations / open questions: <none | list>
```
