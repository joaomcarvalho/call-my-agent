# T8 · Protocol hardening (security review findings 1–5, 8, 9, 11, 12a)

**Owns:** `packages/protocol/src/{state,plan,render,agreement,templates}.ts` and their tests; new `packages/protocol/test/hardening.test.ts`. You may also edit `test/fixtures/*` and regenerate `worked-final.md` when a rule change below requires it (say so in the report).

The reviewer's PoCs are in `/private/tmp/claude-501/-Users-joaom-workspace/a41030d1-5f67-484d-adbf-486ee169fa35/scratchpad/review/protocol.poc.test.ts`. Port each relevant PoC into `hardening.test.ts` as a test asserting the safe behaviour. All must pass.

## Decisions (implement exactly; update `docs/design/implementation-spec.md` §2 to match)

1. **Never throw, bound the work.** Before `verifyEnvelope`, an iterative (non-recursive) walk rejects any envelope with JSON depth > 64 or more than 20 000 nodes → `BAD_SCHEMA`. Wrap each step of `replay` (and `validateNext`) in try/catch; any exception → rejected `BAD_SCHEMA` with the message.
2. **Patch cost.** A patch has at most 200 ops (`BAD_PATCH`). Apply ops one at a time and check JCS size ≤ `max_plan_bytes` after each op (`TOO_LARGE`).
3. **Decisions always checkpoint.** A proposal that adds, changes or removes any decision requires the checkpoint refs of §2.6 (proposer and accepter), regardless of `kind`. Kinds in `checkpoint_kinds` still trigger it for non-decision changes declared in `kinds`.
4. **plan_v0 is canonical.** `session_open.plan_v0` must deep-equal `createPlanV0(charter, charter_hash, charter.invitee_label)`, else `CHARTER_MISMATCH`.
5. **Attribution over the union.** `ownerViolation` compares the union of decision ids before and after: removing or changing a decision whose `before.decided_by` is the other party's human is `OWNER_VIOLATION`, as is producing one.
6. **Renderer cannot hide or fake content.**
   - Plan strings may not contain lone surrogates, C0 controls other than `\n` and `\t`, C1 controls, or bidi/zero-width format characters (U+200B–U+200F, U+202A–U+202E, U+2060–U+2069, U+FEFF) → `PlanSchema` fails → `BAD_PATCH`.
   - In section `md`, outside fenced code blocks and inline code spans, every `<` is emitted as `&lt;`; ATX headings are shifted so they render at level 4 or deeper.
   - In table cells and inline text, `<` → `&lt;` and `|` stays escaped.
7. **Signoff identity.** A `signoff` whose `statement.human` differs from that party's `identity.human` → `SIGNOFF_MISMATCH`.
8. **Agreement verification against known keys.** `verifyAgreementFile(text, expected?: { humanKeys?: Partial<Record<Party, KeyId>> })`: when given, a mismatching `human_key` fails with `unexpected key for party X`. The verdict also returns each party's `agent_key` from the file.
9. **TTL anchor bounded.** `welcome.ts` must be ≥ `charter.created_at` and ≤ `charter.expires_at`, else the welcome is rejected `INVALID_STATE`.

## Acceptance criteria

- **AC1** Every PoC in `protocol.poc.test.ts` has a ported test in `hardening.test.ts` that passes.
- **AC2** A 50 000-deep body and a 30-op `copy` doubling patch are each rejected in < 200 ms, and `replay` never throws on either.
- **AC3** A decision added without `kind` cannot be accepted without the accepter's checkpoint ref.
- **AC4** The rendered output of a section md containing `<!--`, `## Decisions`, `| fake | row |`, and an ESC sequence (rejected by schema) cannot hide later sections: test that every section title, the Disagreements heading and Action items heading still appear outside any `<!--` in the rendered text.
- **AC5** AC11 of T2 (validateNext agrees with replay) still holds over all scenarios, including the new ones.
- **AC6** `bun run check` passes.
