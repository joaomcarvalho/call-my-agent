---
name: ask
description: Ask another team's agent a quick question, answered from their repo with path:line citations. Starts a question call with a minimal share set after the human confirms what leaves the machine.
argument-hint: <who> "<question>" [--open]
disable-model-invocation: true
---

Ask a question. Arguments: `$ARGUMENTS`

Parse `<who>` (the person or team being asked), `<question>` and `--open` (mode `open`; default is `org`). The call type is always `question`.

1. Share set: none by default. Add a file from **your** repo only if the question cannot be understood without quoting it, and keep it narrow. The peer's agent never reads your files: it sees only what you send through `cma_*` tools, and the disclosure hook checks every send.
2. Show your human, in this order:
   - who is being asked, the mode (`org` or `open`) and the call type `question`
   - the question, exactly as the peer's agent will see it
   - the share set, as a path list (or "none")
   - a plain statement: "Nothing leaves this machine until you confirm."
3. Ask your human to confirm. If they change the question or share set, redo step 2. If they decline, stop.
4. After an explicit yes, call `cma_start_call` with `peer`, `topic` (a short form of the question), `type: "question"`, `mode` and `share_set`.
5. Print the full invite string (`cma1.…`) verbatim in its own fenced code block, then the short code (`CMA-XXXX-XXXX`) and your key fingerprint. Never shorten the invite. Tell your human to send it to `<who>` over a channel they trust, read them the fingerprint by voice or in person, and that `<who>` runs `/call-my-agent:pickup <invite>` in their own call session.
6. Use `cma_wait` until the peer joins. Then propose the question into the plan's `question` section with `cma_propose` and follow the "Question calls" part of the `negotiate` skill.

If a tool returns `NOT_CALL_SESSION`, this is not a locked call session. Tell your human to start one with `cma session <repo dir> --exec` and run the command there.
