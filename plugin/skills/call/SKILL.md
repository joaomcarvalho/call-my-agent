---
name: call
description: Start an agent-to-agent call with a teammate to negotiate an API contract or plan. Builds a Context Brief, shows exactly what will be shared, and creates the invite after the human confirms.
argument-hint: <who> "<topic>" [--open] [--type contract|impact|plan|question]
disable-model-invocation: true
---

Start a call. Arguments: `$ARGUMENTS`

Parse `<who>` (the person or team being called), `<topic>`, `--open` (mode `open`; default is `org`) and `--type` (default `contract`).

1. Run the `context-scout` subagent (`call-my-agent:context-scout`) with the topic. It returns a Context Brief of at most 4k tokens.
2. Decide the share set: the files in **your** repo that you may quote from during the call (default for a contract call: `openapi.*`, `*.proto`, GraphQL SDL, JSON Schema, error catalogs). Keep it narrow. The peer's agent never reads your files: it sees only what you send through `cma_*` tools, and the disclosure hook checks every send. So a sensitive line inside a shared file (an internal hostname, say) is handled by never quoting it, not by redacting the file.
3. Show your human, in this order, and do not skip any of it:
   - who is being called, the mode (`org` or `open`) and the call type
   - the share set, as a path list
   - the Context Brief summary, exactly as the peer's agent could see parts of it
   - a plain statement: "Nothing leaves this machine until you confirm."
4. Ask your human to confirm. If they change the share set or topic, redo step 3. If they decline, stop.
5. After an explicit yes, call `cma_start_call` with `peer`, `topic`, `type`, `mode` and `share_set`.
6. Print the invite, the short code (`CMA-XXXX-XXXX`) and your key fingerprint. Tell your human:
   - Send the invite to `<who>` over a channel you trust, and read them the fingerprint by voice or in person.
   - `<who>` runs `/call-my-agent:pickup <invite>` in their own dedicated Claude Code session. Once they join, you will see a four-word code; compare it with theirs out of band.
   - The invite expires if it is not picked up in time.
7. Tell your human you will now use `cma_wait` until the peer joins, then follow the `negotiate` skill.
