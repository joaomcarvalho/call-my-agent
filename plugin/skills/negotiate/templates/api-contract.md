# API contract plan: what a good one contains

Section ids are suggestions. Owner is the party that can speak for that part; use `joint` for anything both must agree.

## 1. Contract diff (`interface`, owner: producer)
- The change as a diff against the current spec, not a re-statement of the whole API. Attach the OpenAPI/proto/schema fragment as an artifact (format and sha256 set).
- Mark each change as additive, behavioural or breaking. Breaking and behavioural changes also appear in `decisions` with `kind: "breaking_change"`.
- Error contract: new or changed status codes and error bodies.

## 2. Consumer call sites (`checklist`, owner: consumer)
- One line per call site: `path:line`, which field or endpoint it uses, what must change.
- Anything the consumer cannot verify from its repo is tagged `unverified` and also listed in `open_items`.

## 3. Rollout: expand, migrate, contract (`rollout`, owner: joint)
1. Expand: producer ships the new shape alongside the old; both work. Date or condition.
2. Migrate: each consumer moves to the new shape. Owner and date per consumer.
3. Contract: producer removes the old shape only after the migration is confirmed. Condition for removal, plus the deprecation date if there is one.
- Rollback: what is reverted if the expand step misbehaves.

## 4. Tasks per side (`action_items`)
- Concrete and owned: "A: add `total_cents` to `GET /orders/{id}` and the OpenAPI spec", "B: migrate `src/jobs/refund.ts`". No shared tasks without a named owner.

## 5. Risks and compatibility (`risks`, owner: joint)
- What breaks if a side slips, what is monitored, and who is paged.

## 6. Decisions, disagreements, open items
- `decisions`: each with `kind`, and `decided_by` as `agent-assumed` unless a human decided.
- `disagreements`: every point the sides did not converge on, with the resolution or `open`.
- `open_items`: `blocking: true` for anything that must be resolved before sign-off.

## Checks before requesting sign-off
- Every consumer named in the call sites has a migration task and a date.
- Every breaking change has a rollout path and a removal condition.
- No claim without `path:line` or an `unverified` tag.
