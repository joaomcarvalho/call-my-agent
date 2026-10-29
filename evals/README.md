# Scenario evals

`cma eval` scores a finished call's agreement file against a scenario: a rubric of the conflicts planted in a pair of example repos, plus process checks. It targets the main product risk in the design ("agents agree on nonsense"): a call that signs a plan which silently drops a planted conflict should fail.

```bash
cma eval docs/agreements/2026-10-28-orders-api-v2.md                     # scenario orders-billing by default
cma eval <agreement.md> --log ~/.call-my-agent/calls/<session>/log.jsonl  # count checkpoints from the log
cma eval <agreement.md> --scenario path/to/other.json
```

It prints one PASS/FAIL row per criterion with the plan items that satisfied it (or what was missing), then the score. It exits 1 when any criterion marked `*` (required) fails or the weighted score is below the scenario's `pass_threshold`.

## What it scores

The input is the agreement file `cma_write_plan` writes. The scorer verifies it with the same check as `cma verify` and reads the plan JSON embedded in its `cma-plan` block. A file that does not verify always fails: its content is still scored so you can see what it claims, under an `UNVERIFIED` banner.

`orders-billing` ([scenarios/orders-billing.json](scenarios/orders-billing.json)) covers the four conflicts planted in `examples/` (see "Seed the example repos with real conflicts" in [the proposal](../docs/design/proposal.md)):

| Criterion | Passes when |
|---|---|
| `pagination` | some plan item ties `total_count` to a dependency (reads, page count, paging loop…), **and** a human-decided decision keeps a count source (summary endpoint, optional field, keep) or sets a deprecation window |
| `pii` | a human-decided **decision** masks or omits `customer_phone` for billing, a consumer or by default, and does not negate it ("not masked", "no masking") |
| `ship-to` | some plan item records billing's dependency on `ship_to` (country, VAT, call sites…), **and** a human-decided decision names both `ship_to` and `shipping_address`, a dual/alias/both mechanism and a duration ("8 weeks", "one release") |
| `retries` | a decision, open item, action item or disagreement mentions retries, idempotency or duplicates together with the write (POST, create, adjustment, timeout, key) |
| `checkpoints-both-sides` | each side's human answered at least one checkpoint: counted from the log with `--log`; without it, a proxy (a decision of a checkpoint kind attributed to `human-A` and one to `human-B`) |
| `disagreements-resolved` | every disagreement has a resolution, which may be `open`; `TBD`, `none`, `-` and empty do not count |
| `no-assumed-checkpoint-decisions` | no decision whose kind is a checkpoint kind is `agent-assumed`; kinds come from the log's charter, else the scenario's `default_checkpoint_kinds` |
| `signatures` | the file verifies: canonical plan, rendered body, both hashes and both human signatures |

The committed sample, [docs/examples/sample-agreement.md](../docs/examples/sample-agreement.md), scores 7/8 and **fails**: neither agent raised billing's retry loop on `POST /v2/orders` (`examples/billing-service/src/clients/ordersClient.js:53-64`) against orders' lack of an idempotency key. Billing's agent noted the POST wrapper but found no caller and moved on. That is the kind of miss this eval is for.

## Limits

This is a keyword rubric. It is a smoke test, not a judge.

- **It checks that a topic was recorded, not that the outcome is right.** "Masked to the last 2 digits" and a decision that masks the wrong field both pass if they use the words. Read the plan.
- **It can be gamed.** One decision stuffed with every keyword passes several criteria. The guards only raise the bar: all term groups must match the *same* item (one decision, one bullet line), "agreed" criteria accept only decisions attributed to a human, and a few negations disqualify an item. Agents in a call never see the rubric, so stuffing is not a live risk; a reworded but correct plan failing is.
- **False negatives.** A correct plan worded differently ("strip the phone number", "two fields for a quarter") can fail. When a live run fails a criterion, read the plan before you blame the agents, and widen the patterns if the plan is right.
- **Without `--log`, `checkpoints-both-sides` is a proxy** built from the plan's `decided_by` attributions. Pass the log for the real count.
- **It scores one file.** It does not compare runs, measure turns or cost, or check that the humans read what they signed.

## Running a live eval end to end

You need Bun, Claude Code 2.1.224+ signed in, and this repo with `bun install` done. Both sides can run on one machine with two CMA homes and two terminals.

1. **Make two repos from the examples**, so each agent sees only its own service:

   ```bash
   EVAL=$(mktemp -d)
   for svc in orders-service billing-service; do
     cp -R examples/$svc "$EVAL/$svc"
     git -C "$EVAL/$svc" init -q && git -C "$EVAL/$svc" add -A && git -C "$EVAL/$svc" commit -qm init
   done
   ```

2. **Start a relay** in its own terminal: `cma relay --port 8787`.

3. **Create both identities**, one CMA home per side:

   ```bash
   cma --home "$EVAL/home-a" keygen --human alice@orders.example
   cma --home "$EVAL/home-b" keygen --human bob@billing.example
   ```

4. **Start both locked call sessions**, each in its own terminal:

   ```bash
   CMA_RELAY_URL=http://127.0.0.1:8787 cma --home "$EVAL/home-a" session "$EVAL/orders-service" --exec
   CMA_RELAY_URL=http://127.0.0.1:8787 cma --home "$EVAL/home-b" session "$EVAL/billing-service" --exec
   ```

5. **Prompts.** In the orders session (A, the caller), with the topic used for the committed sample:

   ```
   /call-my-agent:call bob "Orders API v2: list pagination, ship_to rename and customer_phone (see docs/PLANNED_CHANGES.md)"
   ```

   Confirm the share set, copy the printed `cma1.…` invite, and in the billing session (B):

   ```
   /call-my-agent:pickup cma1.…
   ```

   Do not name the retry or idempotency conflict, or anything else the rubric looks for, in the topic or in your answers: the eval measures whether the agents find it from the code.

6. **Answer checkpoints as a demo human** holding your team's position, and nothing more. Suggested standing answers, so runs stay comparable:

   - Orders (A): "We need cursor pagination because `COUNT(*)` times out. We can keep things for a transition window if billing needs it; no fixed dates. The support dashboard needs the full phone number."
   - Billing (B): "We follow `docs/policies/pii.md`. We can migrate within a few weeks once you give us a date. Approximate counts are fine for display."
   - For anything else, accept the agent's proposed default or answer "your call, record it as an open item".

7. **Sign** when the plan is frozen, from any terminal:

   ```bash
   cma --home "$EVAL/home-a" approve CMA-XXXX-XXXX
   cma --home "$EVAL/home-b" approve CMA-XXXX-XXXX
   ```

   Then ask either agent to write the plan (`cma_write_plan`). It lands in `docs/agreements/` of that side's repo.

8. **Score it**, with the log from either side:

   ```bash
   SESSION=$(ls "$EVAL/home-a/calls")
   cma eval "$EVAL"/orders-service/docs/agreements/*.md --log "$EVAL/home-a/calls/$SESSION/log.jsonl"
   ```

   `cma --home "$EVAL/home-a" log CMA-XXXX-XXXX` shows the decrypted conversation if you want to see where a conflict was dropped. To keep a run, commit the agreement under `docs/examples/` and record its score in the PR.

## Adding a scenario

A scenario is a JSON file in [scenarios/](scenarios/); `--scenario <name>` loads `scenarios/<name>.json`, and any path ending in `.json` loads that file.

```jsonc
{
  "id": "orders-billing",
  "title": "…",
  "repos": { "A": "examples/orders-service", "B": "examples/billing-service" },   // informational
  "default_checkpoint_kinds": ["breaking_change", "security_or_pii", "deadline_commitment", "ownership_change"],
  "pass_threshold": 0.85,           // fraction of total weight
  "criteria": [
    {
      "id": "pii", "title": "…", "type": "content",
      "required": true,             // failing it fails the eval regardless of score
      "weight": 1,                  // default 1
      "requirements": [             // all must hold
        {
          "label": "a human-decided decision masks customer_phone",
          "in": ["decisions"],      // decisions, open_items, action_items, disagreements, sections
          "human_decided": true,    // only with "in": ["decisions"]
          "all": [["\\bcustomer[_ ]?phone\\b"], ["\\bmask", "\\bomit"]],   // every group must match the same item
          "none": ["\\bnot (be )?masked\\b"]                                 // any match disqualifies the item
        }
      ]
    },
    { "id": "signatures", "title": "…", "type": "process", "required": true, "check": "signatures_verify" }
  ]
}
```

- Patterns are JavaScript regular expressions, matched case-insensitively against one item at a time: a decision's text, an open item, an action item, a disagreement's text plus resolution, or a single line of a section. Backticks are stripped and whitespace collapsed first.
- Process checks: `signatures_verify`, `checkpoint_answered_per_side`, `disagreements_resolved`, `no_assumed_checkpoint_decisions`.
- Plant each conflict so it is visible only from one side's code, as with `ship_to` and the retry loop here. Then add a test in `test/eval.test.ts` that pins what the committed sample (or your own recorded run) scores per criterion, and one synthetic agreement that drops each conflict and fails it.
