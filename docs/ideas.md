# Ideas and roadmap

A working list of use cases and improvements, written after the first live calls (one contract call between two Claude agents, one solo call with a human on one side, one sync call between two forked exploration sessions). Nothing here is committed to; each item says what it is, why it matters and roughly how big it is.

## What the live calls taught us

| Observation | Evidence | Where it points |
|---|---|---|
| Humans were interrupted 9 times per call; the design target is 2–5 | `docs/examples/sample-agreement.md` run: 9 checkpoints across 7 plan versions | Pre-authorised ranges in checkpoint answers (below) |
| Strict alternating floor forces filler `say` messages | The sync test fixture needs a `say` just to hand the floor back | Floor `hold`/`yield` |
| One side waits idle while the other's session is offline | Both agents spent turns on empty `cma_wait`s while the peer's process was not running | Presence-aware waiting, a background call worker |
| A sign-off deadlock slipped past 300+ tests | The requester held the floor while waiting for the answer (fixed in `50847b7`) | Model-check the state machine |
| A sync call carries the whole exploration into every re-wake | Forked sessions start with the full exploration context | Compact the fork before the call |
| Agents found a real gap nobody planted | `POST /v2/orders` also returned raw `customer_phone` | The format works; evals should reward discoveries, not only planted items |

## Use cases

| Use case | Shape | What's missing today | Size |
|---|---|---|---|
| **API contract** between producer and consumer | 2 parties, signed plan | Done | — |
| **Sync exploratory work** | 2 forked sessions, signed sync note | Done | — |
| **Breaking-change impact**: "we're dropping field X; what breaks on your side?" | 1 producer, N consumers | Multi-party calls, an `impact` template with a per-consumer section | L |
| **Ask another team's agent**: "how does your service handle retries?" | 2 parties, no sign-off | A `question` flow that ends with a cited answer instead of a signed plan; the type exists but has no template or skill | M |
| **Onboarding interview**: a new engineer's agent interviews the owning team's agent about a service | 2 parties, Q&A plus a summary | Same as above, plus a "brief for a newcomer" template | M |
| **Cross-PR compatibility check**: "will my PR break you?" | Producer PR + consumer agent | Consumer side needs to run its own tests in a sandbox (network off); the call profile denies Bash today | L |
| **On-call handoff** between shifts or teams | 2 parties, async | Durable call outlives sessions already; needs a handoff template (open incidents, hypotheses, next checks) | S |
| **Vendor integration** across companies | Open mode | Verified identities (GitHub, domain), NDA attestation, admin policy (design exists, not built) | L |

## Protocol and product improvements

Ranked roughly by value for effort.

1. **Pre-authorised ranges in checkpoint answers.** Let a human answer with a policy, not just a decision: "accept any `ship_to` window of 8 weeks or more; ask me about anything shorter". The answer summary carries a machine-checkable bound, and a later accept inside it can cite the earlier `checkpoint_ref`. Cuts interrupts without letting the agent decide alone. Needs a small schema for bounds and a rule in §2.6. *M*
2. **Floor `hold`/`yield`.** The envelope already has an unused `floor` field. Let a sender keep the floor for a short run of messages (`hold`) and pass it explicitly (`yield`), with a cap per run. Removes filler messages and halves round trips for multi-part answers. *S*
3. **Model-check the state machine.** Encode the replay rules as a small TLA+ or property-based model and search for states where neither party can make progress, or where a signoff can apply to two different hashes. The sign-off deadlock would have been found mechanically. *M*
4. **A call worker for when the human is away.** A headless `claude -p` worker per call, in the same locked profile, that answers from the repo and parks at checkpoints, so a call keeps moving overnight. Uses the existing ownership lock. Needs a clear "away" policy: no decisions, only facts and questions. *M*
5. **Compact the fork for sync calls.** Before the first message, have the forked session write its "What I learned" brief and then compact to it, so re-wakes don't replay the whole exploration. Claude Code's `/compact` with instructions may be enough. *S*
6. **Desktop notifications.** A `Notification` hook that fires when your agent asks you something or the call freezes, plus the status line command. *S*
7. **`cma log --plan`.** Show the plan as it evolved: one diff per accepted version with who proposed it and which checkpoint covered it. Makes sign-off review faster and supports audits. *S*
8. **Verified identity.** GitHub device flow to bind a key to a login (assurance `email_verified`); org attestation through OIDC later. Today identities are self-asserted and rely on the fingerprint and four-word check. *L*
9. **Multi-party calls.** Round-robin floor, N-way sign-off, per-party sections. Unlocks breaking-change impact across many consumers. The envelope's vector-clock `ack` is already N-ready. *L*
10. **Hosted relay.** Cloudflare Durable Objects, one per call, per the original design, so nobody has to run a relay. *L*
11. **Invites through Slack.** Send the invite as a Slack DM through the Slack MCP after the human confirms, with the fingerprint in a separate message. *S*
12. **A2A adapter.** Expose a call as an A2A task so non-Claude agents can join. *L*

## Known rough edges

- After a call closes, one side can show `AGREED` instead of `CLOSED` until its session next syncs with the relay.
- If the inviter inspects their own invite while the call is live, the inspect re-takes the inviter's relay seat and the live connection loses its token.
- Agents in call sessions mention being unable to `git fetch` when the user's global `CLAUDE.md` asks for it; harmless, but noisy. A call-session-specific instruction could tell them the repo is read as-is.
- The context scout and the call sessions run on whatever model the session uses; there is no per-role model choice in the call profile yet.
