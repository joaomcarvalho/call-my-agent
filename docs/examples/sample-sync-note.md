---
cma: "0.1"
session: "ses_g5drs5xom6pldm6w"
mode: "org"
version: 4
plan_hash: "sha256:c125239f727d2f46280d1ceebfa53f546df2cc49fdc778030c05daadcb352561"
md_hash: "sha256:85e5965e7c890c36fa275d46b4bc27cd62b5a201768f64178d0d787074880f68"
charter_hash: "sha256:9bdfb5ac9da7855893a87d07f26d42012bbffa08aab17a71fbba7f0efd2daeb0"
parties:
  A:
    human: "alice@orders.example"
    agent_key: "ed25519:fa6c3f7aeb614a401614d6cce460b1cac7732f6c18ec03da4a53a4822201b684"
    human_key: "ed25519:b01f76aeab6688731d90024912bd36b26bf15f95277f79749707de5b312bdb71"
  B:
    human: "bob@billing.example"
    agent_key: "ed25519:bd397e3b1d98846416beb1b7101fe06059ff31720cd9669d3d553a985196c117"
    human_key: "ed25519:b12781b40c0aaa8480acc0581594593bf1e08c1dda00b2f1bf5c828f58b01159"
signoffs:
  A:
    signed_at: "2026-10-29T03:29:21.640Z"
    sig: "izR6kuIDWaph_94SBsV3ACqfghwnhd6TDUhENRrwg2qo0ibU3Lor4YmrzXFLYtSBo1ZS233UFrn4nkGFmqa6Dg"
  B:
    signed_at: "2026-10-29T03:29:21.737Z"
    sig: "KpvjXeAFfjus0P6UeSO8NMhUeWFFMNm484wgomMLXmp6YeBPlTPdkeVU0EMr8ZtE7bYBfWF9AfSlINO-tTrhAQ"
---
# Order events for billing: sync our explorations

sync · version 4 · session `ses_g5drs5xom6pldm6w` · A: alice@orders.example · B: bob · charter `sha256:9bdfb5ac9da7855893a87d07f26d42012bbffa08aab17a71fbba7f0efd2daeb0`

## Decisions

| ID | Decision | Kind | Decided by | Decided in |
| --- | --- | --- | --- | --- |
| d-no-pii | Order events omit customer_phone and the street address. Consumers receive ids, status, timestamps, amount_cents, currency and country. | security_or_pii | human-A | `sha256:da0db1003f424bd1148fecd4c7bcc35d531917f5014113d723f8aeb7120dc8e9` |
| d-ordering | Ordering contract is a per-order sequence that consumers compare; there is no delivery-order guarantee. | scope_change | human-A | `sha256:da0db1003f424bd1148fecd4c7bcc35d531917f5014113d723f8aeb7120dc8e9` |

## Goal

_Section `goal` · prose · owner: joint_

Align on what Orders can emit as order events and what billing needs from them. Sync of exploratory work; no commitments.

## Findings (A)

_Section `a.findings` · prose · owner: A (alice@orders.example)_

**Question (A):** how could Orders push created/updated/cancelled events to downstream services via webhooks?

**Findings (repo evidence):**
- Only create exists: `POST /v2/orders` is the sole write path (`src/routes/orders.js:36`). Nothing updates or cancels an order, though `paid`, `shipped`, `cancelled` are in the status enum (`openapi.yaml:69`). Updated/cancelled events have no code to hang off yet.
- No `updated_at` or version column in the `Order` schema (`openapi.yaml:56`) or in the queries (`src/routes/orders.js:19`), so there is no record of when an order changed.
- `src/db` is not in the repo: schema, transactions and migrations unseen. No queue, worker, auth or tenant model in the repo.
- `docs/PLANNED_CHANGES.md` renames `ship_to` to `shipping_address` (old name readable for one release), moves to cursor-only pagination and drops `total_count`.
- `customer_phone` is PII: optional on create (`openapi.yaml:131`), nullable on read (`openapi.yaml:87`).
- Polling `GET /v2/orders` cannot substitute for events: no `updated_at` filter, offset paging being removed, `COUNT(*)` already times out (`src/routes/orders.js:27`).

**Tentative design (A's proposal, not agreed, not verified against running code):**
- At-least-once delivery, consumers dedupe on event `id`; event written to an outbox table in the same DB transaction as the order change.
- Envelope: `id`, `type`, `api_version`, `occurred_at`, per-order `sequence`, `data.order` as full snapshot plus `changed_fields` on updates. `order.cancelled` is its own type.
- Retry on 5xx/429/408/timeouts, exponential backoff with full jitter capped ~6h, honour `Retry-After`, dead-letter after ~24h.
- No global or per-order delivery-order guarantee; consumers compare `sequence`.
- HMAC-SHA256 over `{timestamp}.{raw_body}`, per-subscription secret, 5 min replay window, two active secrets for rotation.
- Subscriptions via `/v2/webhook-subscriptions`, HTTPS only, private IPs blocked.

**Ruled out:** exactly-once delivery (not achievable over HTTP); inline send in the request handler (consumer outage affects order creation, crash loses event); broker publish after commit without outbox (dual write); strict global ordering (head-of-line blocking); ID-only events (no get-by-id endpoint); static token / IP allowlist (no integrity or replay protection); polling (see above).

**Not looked at (A):** billing's needs, any consumer code, the real DB schema, who else writes to `orders`.

## Findings (B)

_Section `b.findings` · prose · owner: B (bob)_

**Question (B):** what would billing need to react to order events instead of polling `GET /v2/orders`?

**Findings (billing repo evidence):**
- Billing reads only `created_at`, `amount_cents` and `ship_to.country` from an order (`src/reports/monthlyRevenue.js:33-39`, `src/tax/vat.js:14-16`). It never reads `id`, `status`, `updated_at`, `currency`, `customer_phone` or the street address.
- The monthly report pages the whole list with offset pagination, filters by `created_at` month and sums (`src/reports/monthlyRevenue.js:11-50`). It prints a `total_count`-based page summary (`src/reports/monthlyRevenue.js:6-9`, `src/clients/ordersClient.js:48`), so dropping `total_count` (A: `docs/PLANNED_CHANGES.md`) breaks that today.
- Billing reads `ship_to` in two places (`src/clients/ordersClient.js:46`, `src/tax/vat.js:15`). The planned rename to `shipping_address` breaks both unless events and the API carry a compatible name.
- `listOrders` spreads the whole upstream order into billing's objects (`src/clients/ordersClient.js:44-47`), so every field Orders returns, including `customer_phone` when populated, already reaches billing code. Billing's own fix is an allow-list at its boundary.
- Billing writes through the API only: `POST /v2/orders` for refund/correction adjustments (`src/clients/ordersClient.js:53-64`). No direct access to the orders table and no other writer known to billing. unverified: other services may exist.
- That POST retries on timeout with no idempotency key (`src/clients/ordersClient.js:55-62`), so a duplicate adjustment can be created.
- No inbound HTTP endpoint, queue consumer, local order store, tests or invoice code exist in this repo, despite the README.

**Answers to A's four questions:**
1. Needed: `order.created` and `order.cancelled`, plus `order.updated` if amount or country can change after creation (it affects revenue and VAT). Nothing on paid/shipped is needed unless it is a status change on `order.updated`. Fields: `order.id`, `status`, `created_at`, `amount_cents`, `currency`, country (`ship_to.country` or its renamed equivalent), and `sequence` and `occurred_at` from the envelope. We would also like a field marking an order as an adjustment, and its parent order id if any.
2. Per-order `sequence` comparison is enough. Billing would keep a store keyed by order id and apply an event only if its sequence is higher; no ordering guarantee needed.
3. Billing needs neither `customer_phone` nor the address. Ids, `amount_cents`, `currency`, status, timestamps and country are enough. We ask that events omit `customer_phone`. Billing will also drop unknown fields on receipt.
4. Billing does not read or write the orders table directly and knows of no other writer.

**Billing-side plan (tentative, not agreed):**
- Local orders table keyed by order id with upsert guarded by `sequence`; processed event id table as a cheap first check; an event for an unknown order creates the row.
- Verify HMAC and replay window on the raw body before parsing; accept two secrets during rotation.
- Monthly report reads the local table. Keep a nightly and month-end reconciliation poll against `GET /v2/orders` because events can be lost.

**Ruled out (B):** dropping polling entirely (lost events would go undetected); ID-only events (agree with A, no get-by-id seen from billing's side); ordering by `occurred_at` alone; last-write-wins by arrival time.

**Not looked at (B):** Orders internals, the real schema, finance rules for cancellations after month close, whether invoices exist elsewhere.

## Shared model

_Section `shared_model` · prose · owner: joint_

Each claim is tagged with its source: **A-repo** (verified by A, with path:line), **B-claim** (billing's statement, not verified by A) or **both** (stated independently by each side).

**What lines up**
- Events cannot replace polling on their own: billing keeps a reconciliation poll (B-claim), and A found the API cannot support one well (no `updated_at` filter, offset paging going away, `COUNT(*)` timing out: `src/routes/orders.js:27`, `docs/PLANNED_CHANGES.md:5-11`). Both sides conclude the reconciliation path is the gap.
- Delivery is at-least-once with consumer dedupe on event `id`; per-order `sequence` is enough for ordering, no delivery-order guarantee needed (both: A proposal, B-claim that it suffices).
- ID-only events are ruled out (both). A-repo: no get-by-id endpoint in `openapi.yaml`.
- Events carry a full order snapshot. Billing needs `id`, `status`, `created_at`, `amount_cents`, `currency` and country, plus envelope `sequence` and `occurred_at` (B-claim).
- `customer_phone` and the street address are not needed by billing and should be omitted from events (B-claim; A agrees PII should be opt-in, `openapi.yaml:87`). This is a shared understanding, not yet a decision.
- Billing writes to Orders only through `POST /v2/orders` and knows of no other writer (B-claim, unverified by A).

**What only one side looked at**
- A only: the outbox approach, envelope and signing sketch, retry schedule, subscription API, SSRF defences. Billing has not reviewed these beyond accepting HMAC with a replay window and two secrets during rotation (B-claim).
- B only: billing's call sites (`ship_to` read in two places), the unprotected adjustment POST retry (B-claim), the local orders table plan.

**What is unresolved**
- Whether adjustments created with `POST /v2/orders` emit `order.created`, and how consumers tell them apart (`o-adjustments`).
- Update and cancel have no write path in Orders today (A-repo: `src/routes/orders.js:36`, `openapi.yaml:69`). Billing wants `order.cancelled` and possibly `order.updated`, which exist only once those paths or another writer exist (`o-writers`).
- Which name events use for `ship_to` and for how long (`o-ship-to`).
- How billing reconciles (`o-reconcile`).

## Risks

_Section `risks` · risks · owner: joint_

- Billing's revenue and VAT reports depend on events that cannot be emitted yet (no update or cancel path in Orders): A-repo `src/routes/orders.js:36`.
- The `ship_to` rename and the `total_count` removal break billing's current code (`src/tax/vat.js`, `src/clients/ordersClient.js`, report page summary) regardless of events: B-claim, consistent with `docs/PLANNED_CHANGES.md:9-17`.
- A duplicate `POST /v2/orders` adjustment can be created on billing's timeout retry because there is no idempotency key (B-claim). If adjustments emit `order.created`, duplicates would reach other consumers too.
- Events can be lost or dead-lettered; without a usable reconciliation path billing's monthly numbers could silently diverge.

## Disagreements

_None._

## Open items

- **o-writers** (open, non-blocking, owner: A): Where do update and cancel come from? If other services write to the orders table directly, an outbox in the API may miss changes (CDC may be needed).
- **o-schema** (open, non-blocking, owner: A): Real orders schema (src/db is outside this repo): needed for outbox, per-order version and updated_at.
- **o-pii** (open, non-blocking, owner: joint): Which consumers may receive customer_phone and address? Does billing need either?
- **o-adjustments** (open, non-blocking, owner: joint): Does a POST /v2/orders adjustment emit order.created? Can consumers tell an adjustment from a customer order (flag or parent id)?
- **o-cancel-month** (open, non-blocking, owner: B): Report treatment of an order cancelled after its month closed (restate vs negative in cancel month). Finance decision, unknown to billing.
- **o-reconcile** (open, non-blocking, owner: joint): With no updated_at filter and offset paging going away, how can billing reconcile against the API? Cursor ordering and a modified-since filter or event replay endpoint needed.
- **o-ship-to** (open, non-blocking, owner: joint): ship_to to shipping_address rename: which name do events use, and does billing get a compatibility window? Billing must update src/tax/vat.js and src/clients/ordersClient.js.
- **o-experiment-outbox** (open, non-blocking, owner: A): Confirm the real orders schema and write paths (A) before committing to an outbox in the API versus CDC.
- **o-idempotency** (open, non-blocking, owner: joint): Should POST /v2/orders accept an idempotency key so billing's timeout retries do not duplicate adjustments?

## Action items

### A · alice@orders.example

- **a-schema-writers**: Proposed, not committed, no date: confirm the real orders schema and write paths to settle outbox vs CDC, and say whether update and cancel paths are coming.
- **a-idempotency-adjustments**: Proposed, not committed, no date: decide whether POST /v2/orders gets an idempotency key and whether adjustments emit order.created.

### B · bob

_None._

<!-- cma-plan
{"action_items":{"A":[{"id":"a-schema-writers","text":"Proposed, not committed, no date: confirm the real orders schema and write paths to settle outbox vs CDC, and say whether update and cancel paths are coming."},{"id":"a-idempotency-adjustments","text":"Proposed, not committed, no date: decide whether POST /v2/orders gets an idempotency key and whether adjustments emit order.created."}],"B":[]},"decisions":[{"decided_by":"human-A","decided_in":"sha256:da0db1003f424bd1148fecd4c7bcc35d531917f5014113d723f8aeb7120dc8e9","id":"d-no-pii","kind":"security_or_pii","text":"Order events omit customer_phone and the street address. Consumers receive ids, status, timestamps, amount_cents, currency and country."},{"decided_by":"human-A","decided_in":"sha256:da0db1003f424bd1148fecd4c7bcc35d531917f5014113d723f8aeb7120dc8e9","id":"d-ordering","kind":"scope_change","text":"Ordering contract is a per-order sequence that consumers compare; there is no delivery-order guarantee."}],"disagreements":[],"meta":{"charter_hash":"sha256:9bdfb5ac9da7855893a87d07f26d42012bbffa08aab17a71fbba7f0efd2daeb0","parties":{"A":"alice@orders.example","B":"bob"},"title":"Order events for billing: sync our explorations","type":"sync"},"open_items":[{"blocking":false,"id":"o-writers","owner":"A","status":"open","text":"Where do update and cancel come from? If other services write to the orders table directly, an outbox in the API may miss changes (CDC may be needed)."},{"blocking":false,"id":"o-schema","owner":"A","status":"open","text":"Real orders schema (src/db is outside this repo): needed for outbox, per-order version and updated_at."},{"blocking":false,"id":"o-pii","owner":"joint","status":"open","text":"Which consumers may receive customer_phone and address? Does billing need either?"},{"blocking":false,"id":"o-adjustments","owner":"joint","status":"open","text":"Does a POST /v2/orders adjustment emit order.created? Can consumers tell an adjustment from a customer order (flag or parent id)?"},{"blocking":false,"id":"o-cancel-month","owner":"B","status":"open","text":"Report treatment of an order cancelled after its month closed (restate vs negative in cancel month). Finance decision, unknown to billing."},{"blocking":false,"id":"o-reconcile","owner":"joint","status":"open","text":"With no updated_at filter and offset paging going away, how can billing reconcile against the API? Cursor ordering and a modified-since filter or event replay endpoint needed."},{"blocking":false,"id":"o-ship-to","owner":"joint","status":"open","text":"ship_to to shipping_address rename: which name do events use, and does billing get a compatibility window? Billing must update src/tax/vat.js and src/clients/ordersClient.js."},{"blocking":false,"id":"o-experiment-outbox","owner":"A","status":"open","text":"Confirm the real orders schema and write paths (A) before committing to an outbox in the API versus CDC."},{"blocking":false,"id":"o-idempotency","owner":"joint","status":"open","text":"Should POST /v2/orders accept an idempotency key so billing's timeout retries do not duplicate adjustments?"}],"parent":"sha256:c0b3664731c68269cd0fdb1f6da43cd9009539e7f58ba1b562478b58606d153c","schema":"cma-plan/1","sections":[{"id":"goal","md":"Align on what Orders can emit as order events and what billing needs from them. Sync of exploratory work; no commitments.","owner":"joint","title":"Goal","type":"prose"},{"id":"a.findings","md":"**Question (A):** how could Orders push created/updated/cancelled events to downstream services via webhooks?\n\n**Findings (repo evidence):**\n- Only create exists: `POST /v2/orders` is the sole write path (`src/routes/orders.js:36`). Nothing updates or cancels an order, though `paid`, `shipped`, `cancelled` are in the status enum (`openapi.yaml:69`). Updated/cancelled events have no code to hang off yet.\n- No `updated_at` or version column in the `Order` schema (`openapi.yaml:56`) or in the queries (`src/routes/orders.js:19`), so there is no record of when an order changed.\n- `src/db` is not in the repo: schema, transactions and migrations unseen. No queue, worker, auth or tenant model in the repo.\n- `docs/PLANNED_CHANGES.md` renames `ship_to` to `shipping_address` (old name readable for one release), moves to cursor-only pagination and drops `total_count`.\n- `customer_phone` is PII: optional on create (`openapi.yaml:131`), nullable on read (`openapi.yaml:87`).\n- Polling `GET /v2/orders` cannot substitute for events: no `updated_at` filter, offset paging being removed, `COUNT(*)` already times out (`src/routes/orders.js:27`).\n\n**Tentative design (A's proposal, not agreed, not verified against running code):**\n- At-least-once delivery, consumers dedupe on event `id`; event written to an outbox table in the same DB transaction as the order change.\n- Envelope: `id`, `type`, `api_version`, `occurred_at`, per-order `sequence`, `data.order` as full snapshot plus `changed_fields` on updates. `order.cancelled` is its own type.\n- Retry on 5xx/429/408/timeouts, exponential backoff with full jitter capped ~6h, honour `Retry-After`, dead-letter after ~24h.\n- No global or per-order delivery-order guarantee; consumers compare `sequence`.\n- HMAC-SHA256 over `{timestamp}.{raw_body}`, per-subscription secret, 5 min replay window, two active secrets for rotation.\n- Subscriptions via `/v2/webhook-subscriptions`, HTTPS only, private IPs blocked.\n\n**Ruled out:** exactly-once delivery (not achievable over HTTP); inline send in the request handler (consumer outage affects order creation, crash loses event); broker publish after commit without outbox (dual write); strict global ordering (head-of-line blocking); ID-only events (no get-by-id endpoint); static token / IP allowlist (no integrity or replay protection); polling (see above).\n\n**Not looked at (A):** billing's needs, any consumer code, the real DB schema, who else writes to `orders`.","owner":"A","title":"Findings (A)","type":"prose"},{"id":"b.findings","md":"**Question (B):** what would billing need to react to order events instead of polling `GET /v2/orders`?\n\n**Findings (billing repo evidence):**\n- Billing reads only `created_at`, `amount_cents` and `ship_to.country` from an order (`src/reports/monthlyRevenue.js:33-39`, `src/tax/vat.js:14-16`). It never reads `id`, `status`, `updated_at`, `currency`, `customer_phone` or the street address.\n- The monthly report pages the whole list with offset pagination, filters by `created_at` month and sums (`src/reports/monthlyRevenue.js:11-50`). It prints a `total_count`-based page summary (`src/reports/monthlyRevenue.js:6-9`, `src/clients/ordersClient.js:48`), so dropping `total_count` (A: `docs/PLANNED_CHANGES.md`) breaks that today.\n- Billing reads `ship_to` in two places (`src/clients/ordersClient.js:46`, `src/tax/vat.js:15`). The planned rename to `shipping_address` breaks both unless events and the API carry a compatible name.\n- `listOrders` spreads the whole upstream order into billing's objects (`src/clients/ordersClient.js:44-47`), so every field Orders returns, including `customer_phone` when populated, already reaches billing code. Billing's own fix is an allow-list at its boundary.\n- Billing writes through the API only: `POST /v2/orders` for refund/correction adjustments (`src/clients/ordersClient.js:53-64`). No direct access to the orders table and no other writer known to billing. unverified: other services may exist.\n- That POST retries on timeout with no idempotency key (`src/clients/ordersClient.js:55-62`), so a duplicate adjustment can be created.\n- No inbound HTTP endpoint, queue consumer, local order store, tests or invoice code exist in this repo, despite the README.\n\n**Answers to A's four questions:**\n1. Needed: `order.created` and `order.cancelled`, plus `order.updated` if amount or country can change after creation (it affects revenue and VAT). Nothing on paid/shipped is needed unless it is a status change on `order.updated`. Fields: `order.id`, `status`, `created_at`, `amount_cents`, `currency`, country (`ship_to.country` or its renamed equivalent), and `sequence` and `occurred_at` from the envelope. We would also like a field marking an order as an adjustment, and its parent order id if any.\n2. Per-order `sequence` comparison is enough. Billing would keep a store keyed by order id and apply an event only if its sequence is higher; no ordering guarantee needed.\n3. Billing needs neither `customer_phone` nor the address. Ids, `amount_cents`, `currency`, status, timestamps and country are enough. We ask that events omit `customer_phone`. Billing will also drop unknown fields on receipt.\n4. Billing does not read or write the orders table directly and knows of no other writer.\n\n**Billing-side plan (tentative, not agreed):**\n- Local orders table keyed by order id with upsert guarded by `sequence`; processed event id table as a cheap first check; an event for an unknown order creates the row.\n- Verify HMAC and replay window on the raw body before parsing; accept two secrets during rotation.\n- Monthly report reads the local table. Keep a nightly and month-end reconciliation poll against `GET /v2/orders` because events can be lost.\n\n**Ruled out (B):** dropping polling entirely (lost events would go undetected); ID-only events (agree with A, no get-by-id seen from billing's side); ordering by `occurred_at` alone; last-write-wins by arrival time.\n\n**Not looked at (B):** Orders internals, the real schema, finance rules for cancellations after month close, whether invoices exist elsewhere.","owner":"B","title":"Findings (B)","type":"prose"},{"id":"shared_model","md":"Each claim is tagged with its source: **A-repo** (verified by A, with path:line), **B-claim** (billing's statement, not verified by A) or **both** (stated independently by each side).\n\n**What lines up**\n- Events cannot replace polling on their own: billing keeps a reconciliation poll (B-claim), and A found the API cannot support one well (no `updated_at` filter, offset paging going away, `COUNT(*)` timing out: `src/routes/orders.js:27`, `docs/PLANNED_CHANGES.md:5-11`). Both sides conclude the reconciliation path is the gap.\n- Delivery is at-least-once with consumer dedupe on event `id`; per-order `sequence` is enough for ordering, no delivery-order guarantee needed (both: A proposal, B-claim that it suffices).\n- ID-only events are ruled out (both). A-repo: no get-by-id endpoint in `openapi.yaml`.\n- Events carry a full order snapshot. Billing needs `id`, `status`, `created_at`, `amount_cents`, `currency` and country, plus envelope `sequence` and `occurred_at` (B-claim).\n- `customer_phone` and the street address are not needed by billing and should be omitted from events (B-claim; A agrees PII should be opt-in, `openapi.yaml:87`). This is a shared understanding, not yet a decision.\n- Billing writes to Orders only through `POST /v2/orders` and knows of no other writer (B-claim, unverified by A).\n\n**What only one side looked at**\n- A only: the outbox approach, envelope and signing sketch, retry schedule, subscription API, SSRF defences. Billing has not reviewed these beyond accepting HMAC with a replay window and two secrets during rotation (B-claim).\n- B only: billing's call sites (`ship_to` read in two places), the unprotected adjustment POST retry (B-claim), the local orders table plan.\n\n**What is unresolved**\n- Whether adjustments created with `POST /v2/orders` emit `order.created`, and how consumers tell them apart (`o-adjustments`).\n- Update and cancel have no write path in Orders today (A-repo: `src/routes/orders.js:36`, `openapi.yaml:69`). Billing wants `order.cancelled` and possibly `order.updated`, which exist only once those paths or another writer exist (`o-writers`).\n- Which name events use for `ship_to` and for how long (`o-ship-to`).\n- How billing reconciles (`o-reconcile`).","owner":"joint","title":"Shared model","type":"prose"},{"id":"risks","md":"- Billing's revenue and VAT reports depend on events that cannot be emitted yet (no update or cancel path in Orders): A-repo `src/routes/orders.js:36`.\n- The `ship_to` rename and the `total_count` removal break billing's current code (`src/tax/vat.js`, `src/clients/ordersClient.js`, report page summary) regardless of events: B-claim, consistent with `docs/PLANNED_CHANGES.md:9-17`.\n- A duplicate `POST /v2/orders` adjustment can be created on billing's timeout retry because there is no idempotency key (B-claim). If adjustments emit `order.created`, duplicates would reach other consumers too.\n- Events can be lost or dead-lettered; without a usable reconciliation path billing's monthly numbers could silently diverge.","owner":"joint","title":"Risks","type":"risks"}],"session":"ses_g5drs5xom6pldm6w","version":4}
-->
