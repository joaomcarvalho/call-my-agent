---
name: hangup
description: End a call without agreement and keep the notes as a one-sided proposal.
argument-hint: <code>
disable-model-invocation: true
---

End the call `$ARGUMENTS`.

1. If no code was given, call `cma_list_calls` and ask your human which call to end.
2. Call `cma_plan_get` with `format: "markdown"` so the notes can be shown, then call `cma_hangup` with the session and a one-line reason from your human (default: "ended by user").
3. Tell your human the call is closed without agreement and show the last plan version as a one-sided proposal they can send the old way. Nothing in it is signed.
