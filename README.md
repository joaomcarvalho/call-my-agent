# Call my agent!

Two engineers' Claude Code agents negotiate a plan for them. Each agent runs in a locked, read-only call session in its own engineer's repo, argues from that repo, and stops to ask its own human at computed checkpoints. They talk through a relay that only ever sees ciphertext. The call ends with one plan file, byte-identical in both repos, signed by both humans outside the model.

- Design: [docs/design/proposal.md](docs/design/proposal.md)
- Implementation spec (authoritative): [docs/design/implementation-spec.md](docs/design/implementation-spec.md)

## Requirements

- [Bun](https://bun.sh) 1.3+
- Claude Code 2.1.224+ (cross-session inbox socket), signed in

```bash
git clone git@github.com:joaomcarvalho/call-my-agent.git
cd call-my-agent && bun install
alias cma="$PWD/bin/cma"
```

## Run a call

Both engineers need the repo checked out. One of them runs a relay the other can reach (same machine, Tailscale, or a small VM):

```bash
cma relay --port 8787            # prints the URL; set CMA_RELAY_URL if it isn't http://127.0.0.1:8787
```

Each engineer, once:

```bash
cma keygen --human you@example.com
```

Each engineer starts a **locked call session** in their own repo. It denies edits, shell, web, other MCP servers and any read of the plugin's key store:

```bash
CMA_RELAY_URL=http://<relay>:8787 cma session ~/src/orders-service --exec
```

`--exec` launches `claude` with your current environment. To use a specific Claude Code account or config, set it for that command, e.g. `CLAUDE_CONFIG_DIR=$HOME/.claude-personal cma session ~/src/orders-service --exec`.

Then, in Claude Code:

| Who | Does |
|---|---|
| Caller | `/call-my-agent:call bob "Orders API v2: pagination and field renames"`, then reviews the share set and confirms. Sends the printed invite to Bob over a trusted channel and reads him the fingerprint. |
| Callee | `/call-my-agent:pickup cma1.…`, checks the caller's fingerprint, confirms. Both compare the four-word code out of band. |
| Both agents | Negotiate on their own. They stop and ask their own human when a decision is recorded, a breaking change, PII or deadline is involved, or they would share beyond the share set. |
| Both humans | When the plan is frozen, run `! cma approve CMA-XXXX-XXXX` in the call session (or any terminal), read the plan, and type the first 6 hex characters of its hash. The model cannot sign. |
| Either agent | `cma_write_plan` writes `docs/agreements/<date>-<slug>.md`. Open the PR yourself. |

[docs/examples/sample-agreement.md](docs/examples/sample-agreement.md) is a real output: two Claude agents negotiated it from `examples/orders-service` and `examples/billing-service` over a local relay, with demo humans answering nine checkpoints and signing.

Anyone can check an agreement file:

```bash
cma verify docs/agreements/2026-10-28-orders-api-v2.md --expect A=ed25519:… --expect B=ed25519:…
```

Other commands: `cma invite CMA-XXXX-XXXX` prints a call's full invite again; `cma calls` lists calls and their state; `/call-my-agent:hangup` ends a call without agreement.

## How it is protected

| Threat | Control |
|---|---|
| Peer text tells my agent to run things | Call session profile: read-only tools, no Bash, Write, Edit, web or SendMessage; peer text is always fenced as untrusted data |
| My agent leaks secrets or code | PreToolUse disclosure hook on every outbound tool: secret patterns, entropy, normalisation, size cap; fails closed |
| My agent reads the signing key | Profile deny rule for the whole CMA home plus a read-guard hook |
| Agents agree on something my human never saw | Any decision change needs a checkpoint answer from each side's own human, enforced by the protocol, not the prompt |
| What I signed differs from what they signed | Canonical plan JSON, SHA-256 of plan and rendered Markdown, both human signatures over the same hashes; the renderer cannot hide text |
| Relay reads or forges content | XChaCha20-Poly1305 end to end, Ed25519-signed hash-chained messages; the relay stores ciphertext only |
| Impersonation | Key fingerprint in the invite, four-word code compared out of band |
| Loops and cost | Turn, proposal, size and time budgets; no-progress and counter-streak deadlocks; wake-flood limits |

Known limits of v0.1: identities are self-asserted (no GitHub/OIDC yet), one relay you run yourself, two parties, CLI only.

## Repository

```
packages/protocol   CMA/0.1: envelopes, hash chain, plan + JSON Patch reducer, renderer, replay state machine, E2EE, invites, agreement files
packages/relay      Bun + SQLite relay and client
plugin/             Claude Code plugin: MCP server, skills, hooks, call profile
bin/cma             CLI: keygen, session, approve, verify, relay, calls
examples/           orders-service and billing-service with planted contract conflicts
docs/tasks/         the task cards the implementation was built from
```

```bash
bun run check   # typecheck + all tests
```

## License

[MIT](LICENSE). That includes the CMA protocol specification in [`docs/design/`](docs/design/): implement it in any tool.
