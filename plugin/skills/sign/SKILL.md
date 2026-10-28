---
name: sign
description: Human-only sign-off. Shows the frozen plan and its hashes and tells the human how to sign in their own terminal. The agent never signs.
argument-hint: <code>
disable-model-invocation: true
---

Sign-off for call `$ARGUMENTS`.

You cannot sign, and no tool exists that signs. Only your human can, in a terminal outside this conversation.

1. Call `cma_status` to confirm the state is `FROZEN`. If it is not, tell your human what the state is and stop.
2. Call `cma_plan_get` with `format: "markdown"` and show the markdown to your human in full, then show the plan hash and the markdown hash it returns.
3. Tell your human:
   - Read the plan, especially the decisions table (items marked `agent-assumed` were not decided by a human) and the disagreements section.
   - To sign, run this yourself in your terminal: `! bun <repo>/bin/cma approve <code>` (replace `<repo>` with the call-my-agent checkout and `<code>` with the call code).
   - The command re-renders the plan from the logged bytes, prints the plan hash and markdown hash, and asks you to type the first six characters of the markdown hash. That check proves you are signing the bytes you were shown, not a summary of them.
   - Any edit after one signature voids it. If something is wrong, tell me what, and I will raise it with the peer using `cma_say`.
4. Do not run the command, do not offer to run it, and do not ask for the typed characters. Then call `cma_wait` to learn when both sign-offs are in.
