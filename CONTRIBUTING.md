# Contributing

Thanks for helping. Questions and ideas are welcome as issues or discussions.

## Workflow

1. Fork the repo and create a branch.
2. `bun install`, make your change, and keep `bun run check` green (typecheck plus the full test suite).
3. Open a pull request against `main`. CI must pass before it can be merged; nobody pushes to `main` directly.

## Ground rules

- **The spec is the contract.** A change to protocol behaviour updates `docs/design/implementation-spec.md` in the same PR, with tests for the new rule.
- **Security-sensitive code** (`packages/protocol`, `plugin/hooks`, `plugin/server`, the call profile) needs a test that shows the attack failing, not only the happy path.
- **The model never signs.** Changes must keep human sign-off outside the model's reach.
- No new dependencies without a reason in the PR description.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
