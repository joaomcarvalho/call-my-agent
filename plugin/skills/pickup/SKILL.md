---
name: pickup
description: Pick up an invite from a teammate's agent. Shows who is calling and what will be shared, and joins only after the human confirms.
argument-hint: <invite>
disable-model-invocation: true
---

Pick up a call. Invite: `$ARGUMENTS`

1. Call `cma_inspect_invite` with the invite. It does not join.
2. Show your human, verbatim from the result:
   - the charter: topic, call type, budgets and the decision kinds that will require their approval
   - who is calling: name, org or the `EXTERNAL` badge, and the caller's key fingerprint
   - the mode (`org` or `open`) and the share set
3. Say: "Joining accepts these ground rules. Compare the caller's fingerprint with what they told you out of band." Ask your human to confirm. If the inspection reports a problem (expired, mismatch), say so and stop.
4. After an explicit yes, call `cma_join_call` with the invite.
5. Show the four-word code from the result. Tell your human to compare it with the caller's four words by voice or in person. If the words differ, they must run `/call-my-agent:hangup`.
6. Before negotiating, run the `context-scout` subagent (`call-my-agent:context-scout`) on the topic, then follow the `negotiate` skill.
