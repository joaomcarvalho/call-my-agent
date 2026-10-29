---
cma: "0.1"
session: "ses_uu7iflfnfva5qjob"
mode: "org"
version: 7
plan_hash: "sha256:3924b360d85faf8cf525d538c56c9d6334c02b324f071e489e9ca358fa372192"
md_hash: "sha256:790d754e6341bff26307987dc1ac52965d1305a3a4557d7315c3530c7fa1e3d6"
charter_hash: "sha256:883dafafcfd1af49fa1cc778d84f588ee5a8f61ce7ce0b0aec851a54fab76329"
parties:
  A:
    human: "alice@orders.example"
    agent_key: "ed25519:6542d3f7de5946acef5be650e0e7012df3c354079c6353bbfb7444e4335bd634"
    human_key: "ed25519:d351d19bfc018928bb55904fa05570ea564d43befb5234b722ea5545e5cc95bc"
  B:
    human: "bob@billing.example"
    agent_key: "ed25519:0bde43d28fff111ef4783e53951c0a21d0bf9fc5fa968f6127e415fc81139da4"
    human_key: "ed25519:ac27ce521f0eb3945e2be1ca131e37ae31d938558739c29dc65c6ecd3c702caa"
signoffs:
  A:
    signed_at: "2026-10-29T01:49:57.799Z"
    sig: "pLvKoWJFV128kvLDTgCz_8Qi-f-d_3hDrZ7rEIkWWUJOqnWRBBu8d5pRBYgidcIfG-MBDv-a_1muTEhfyoRLCw"
  B:
    signed_at: "2026-10-29T01:49:57.919Z"
    sig: "eW0YIE6e0AZMl1lyBFmrlljVFHfwCwafz-1KyP8_nIPC0gvkdq4Dw50wNqtFSuvbZGXy0C2cchuMN4JLP5O2BA"
---
# Orders API v2: list pagination, ship_to rename and customer_phone (see docs/PLANNED_CHANGES.md)

contract · version 7 · session `ses_uu7iflfnfva5qjob` · A: alice@orders.example · B: bob · charter `sha256:883dafafcfd1af49fa1cc778d84f588ee5a8f61ce7ce0b0aec851a54fab76329`

## Decisions

| ID | Decision | Kind | Decided by | Decided in |
| --- | --- | --- | --- | --- |
| d-a-cursor-expired | An expired cursor returns HTTP 410 with error code cursor_expired; the client restarts from page 1. | breaking_change | human-A | `sha256:862b61c19d31e1d7c0ae135e65000428995d8a8c59356b6f6a5f4c7f2b588923` |
| d-a-cursor-rules | next_cursor is an opaque string, valid 24 hours, ordered by created_at descending then id descending, stable within that window. | breaking_change | human-A | `sha256:033fed864fdcf3b07cb4722f44a56bc9f1d7a4125e35a8eea261432af7c98ada` |
| d-a-phone-all-responses | customer_phone masking (last 2 digits) and the phone:read scope apply to every response that returns an Order, including the 201 from POST /v2/orders. | security_or_pii | human-A | `sha256:cef5f31295f5bf7c12641d5098d0a634a723f247e505a46f260873284da92e21` |
| d-a-phone-masked-default | customer_phone in the list response is masked to the last 2 digits by default. The raw number is returned only with a new phone:read scope, granted only to the support dashboard. | security_or_pii | human-A | `sha256:67f0c13e3441575c5189a65973acfd083eb1431555b18385eb4dad6c740d4232` |
| d-a-retirement | limit/offset and total_count are retired from the list response no earlier than 8 weeks after GET /v2/orders/summary is live; cursor and offset coexist until then. No calendar date is committed. | breaking_change | human-A | `sha256:862b61c19d31e1d7c0ae135e65000428995d8a8c59356b6f6a5f4c7f2b588923` |
| d-a-ship-target | Target quarter for shipping shipping_address is Q1 2027, no fixed day. The 8-week dual-field window starts on the ship date. | deadline_commitment | human-A | `sha256:033fed864fdcf3b07cb4722f44a56bc9f1d7a4125e35a8eea261432af7c98ada` |
| d-a-ship-to-window | 8-week dual-field window: responses carry both ship_to and shipping_address, and requests accept both names, for 8 weeks from the date shipping_address ships. No ship date is committed yet. | deadline_commitment | human-A | `sha256:67f0c13e3441575c5189a65973acfd083eb1431555b18385eb4dad6c740d4232` |
| d-a-summary-before-removal | Orders ships GET /v2/orders/summary returning total_count (may be approximate on unfiltered queries) BEFORE removing total_count from the list response. total_count stays in the list response until the summary endpoint is live. | breaking_change | human-A | `sha256:67f0c13e3441575c5189a65973acfd083eb1431555b18385eb4dad6c740d4232` |
| d-a-summary-v1 | GET /v2/orders/summary v1 takes no filters; the unfiltered count is approximate within plus or minus 1 percent. | breaking_change | human-A | `sha256:033fed864fdcf3b07cb4722f44a56bc9f1d7a4125e35a8eea261432af7c98ada` |
| d-b-phone-masked | B must not receive raw `customer_phone`. Masked to the last 2 digits, or omitted for B's client, is acceptable. | security_or_pii | human-B | `sha256:b6c1717fdefef8c5cdc1372f82290704a7955f92401ba0bfbeda5bdb9acbd3b0` |
| d-b-ship-to-window | B accepts a dual-field read (`ship_to` and `shipping_address` both in responses) for 8 weeks from the date Orders ships `shipping_address`. Billing team owns B's migration. Orders to confirm the window and the mechanism. | deadline_commitment | human-B | `sha256:b6c1717fdefef8c5cdc1372f82290704a7955f92401ba0bfbeda5bdb9acbd3b0` |
| d-b-total-count | B accepts cursor-only paging only if Orders provides a count another way (optional `total_count`, or a summary endpoint returning the count). Otherwise `total_count` stays. Dropping it with no replacement is not acceptable to B. | breaking_change | human-B | `sha256:b6c1717fdefef8c5cdc1372f82290704a7955f92401ba0bfbeda5bdb9acbd3b0` |

## Context

_Section `context` · prose · owner: joint_

Orders team (A) changes `/v2/orders` in three ways: cursor-only pagination, `ship_to` renamed `shipping_address`, and `customer_phone` returned in the list response (`docs/PLANNED_CHANGES.md:5-23`). B (billing-service) is a consumer; its call sites are in B's implementation notes.

## Interface

_Section `interface` · interface · owner: joint_

**Current contract**
- `GET /v2/orders`: `limit` 1-200 default 50, `offset` min 0 (`openapi.yaml:14-28`). Returns `OrderList` with required `data` and `total_count` (`openapi.yaml:108-120`).
- `Order` requires `ship_to` (`openapi.yaml:65`) and carries nullable `customer_phone` (`openapi.yaml:87-88`).
- `CreateOrderRequest` requires `ship_to` (`openapi.yaml:127`); optional `customer_phone` string (`openapi.yaml:131-132`).
- `ShipTo`: `line1`, `city`, `postal_code`, `country` (`openapi.yaml:91-107`).

**Cursor pagination (`GET /v2/orders`)**
- `cursor` query parameter and `next_cursor` in the response, null on the last page (`docs/PLANNED_CHANGES.md:7-8`).
- `next_cursor` is an opaque string. Clients must not parse it.
- A cursor is valid for 24 hours.
- Order is `created_at` descending, then `id` descending, stable within that 24-hour window.
- Clients stop paging when `next_cursor` is null, never on a count.
- Cursor and `limit`/`offset` coexist until `limit`/`offset` are retired (see Retirement).

**Error contract**
- Expired cursor: HTTP 410, error code `cursor_expired`. The client restarts from the first page.
- Existing: HTTP 400 `invalid_order` on `POST /v2/orders` (`openapi.yaml:52-53`).

**Retirement**
- `limit`/`offset` and `total_count` are removed from the list response no earlier than 8 weeks after `GET /v2/orders/summary` is live. No calendar date is committed.

**Summary endpoint (`GET /v2/orders/summary`, v1)**
- Returns `total_count`. Takes no filters.
- The unfiltered count is approximate, within plus or minus 1 percent.
- Ships before `total_count` is removed from the list response.

**`ship_to` to `shipping_address`**
- Same shape (`line1`, `city`, `postal_code`, `country`) (`docs/PLANNED_CHANGES.md:16`).
- For 8 weeks from the date `shipping_address` ships, responses carry both `ship_to` and `shipping_address`, and requests accept both names.

**`customer_phone`**
- In every response that returns an `Order`, including the list and the 201 from `POST /v2/orders` (`openapi.yaml:46-51`), `customer_phone` is masked to the last 2 digits by default.
- The raw number is returned only with the new `phone:read` scope, granted only to the support dashboard.

**Not yet specified:** how `phone:read` is expressed (`openapi.yaml` declares no security scheme).

## Implementation notes (A)

_Section `a.impl_notes` · prose · owner: A (alice@orders.example)_

- Reason given for dropping `total_count`: the `COUNT(*)` query times out on the orders table at current volume (`docs/PLANNED_CHANGES.md:9-10`). unverified: no latency metric or volume figure is attached to this claim.
- A's repo has no in-repo consumers of these endpoints. unverified: consumers outside this repo, including the support dashboard named in `docs/PLANNED_CHANGES.md:22`.
- No auth scheme, rate limit or deprecation policy is declared in the spec.

## Implementation notes (B)

_Section `b.impl_notes` · prose · owner: B (bob)_

**B call sites (billing-service)**
- `src/clients/ordersClient.js:41-42`: `GET /v2/orders` sends `limit` and `offset`; page size 100 (`src/reports/monthlyRevenue.js:4`).
- `src/clients/ordersClient.js:41-51` and `src/reports/monthlyRevenue.js:16-22`: read `total_count` for the page count and the paging-loop stop condition. Cursor-only paging means rewriting both.
- `src/clients/ordersClient.js:46` and `src/tax/vat.js:15`: read `ship_to.country`. `ordersClient.js:46` has no null guard.
- `POST /v2/orders` wrapper at `src/clients/ordersClient.js:53-57`. unverified: no caller found in this repo, so live use is unknown.
- `customer_phone`: no call site in B.

**B constraint**
- B must never receive raw phone numbers. Masked to the last 2 digits, or omitted for B's client, is acceptable.

B's checkout was not fetched from the remote; findings are from the local copy.

## Rollout

_Section `rollout` · rollout · owner: joint_

1. Orders ships `GET /v2/orders/summary`. `total_count` stays in the list response until it is live.
2. Orders ships `shipping_address`, target quarter Q1 2027, no fixed day. From that date, 8 weeks of dual-field responses and dual-name requests.
3. `customer_phone` masked by default in every Order-returning response; `phone:read` for the support dashboard only.
4. Cursor pagination ships alongside `limit`/`offset`. Orders retires `limit`/`offset` and `total_count` no earlier than 8 weeks after the summary endpoint is live.

Only the Q1 2027 target for step 2 is a committed date. No date is committed for steps 1, 3 and 4.

## Risks

_Section `risks` · risks · owner: joint_

- Dropping required `total_count` and renaming required `ship_to` break existing clients (`openapi.yaml:65`, `openapi.yaml:110-112`, `openapi.yaml:127`); both are staged behind the windows above.
- A report that runs longer than 24 hours gets 410 `cursor_expired` and must restart from the first page.
- The summary count is approximate (plus or minus 1 percent); it is suitable for display, not reconciliation.
- The ship date is a target quarter only, so B cannot fix its migration dates until Orders ships `shipping_address`.
- Masking depends on Orders identifying the caller for `phone:read`; the spec has no security scheme yet (oi-phone-scope).

## Disagreements

_None._

## Open items

- **oi-b-call-sites** (resolved, blocking, owner: B): B to list its call sites of GET/POST /v2/orders: which of limit/offset, total_count, ship_to, customer_phone it reads or writes, with path:line.
- **oi-total-count-need** (resolved, blocking, owner: B): Does B depend on total_count (page counts, reconciliation)? If yes, what replaces it.
- **oi-ship-to-window** (resolved, blocking, owner: joint): Length and mechanism of the ship_to to shipping_address transition; B's migration time needed.
- **oi-cursor-rules** (resolved, non-blocking, owner: A): next_cursor schema, expiry and ordering guarantees to be written by A once B's paging needs are known.
- **oi-phone-masking** (resolved, blocking, owner: A): A to say whether `customer_phone` is returned raw or masked, and whether it can be masked to the last 2 digits or omitted for B's client.
- **oi-count-replacement** (resolved, blocking, owner: A): A to say how a count is provided if `total_count` is dropped (optional `total_count` or a summary endpoint). A's doc puts the summary endpoint out of scope (`docs/PLANNED_CHANGES.md:11`).
- **oi-ship-to-requests** (resolved, non-blocking, owner: A): A to say whether the `ship_to` rename applies to `CreateOrderRequest` as well as responses.
- **oi-ship-date** (resolved, blocking, owner: A): The 8 weeks start when shipping_address ships; no date or target quarter is committed. A to bring a target to its human; B cannot schedule its migration until there is one.
- **oi-summary-contract** (resolved, blocking, owner: A): Summary endpoint contract: path is GET /v2/orders/summary; error bound for approximate counts on unfiltered queries, whether filtered counts are exact, and which list filters it accepts are not yet specified. B's human has not accepted approximate counts.
- **oi-phone-scope** (open, non-blocking, owner: A): The spec declares no auth scheme (openapi.yaml has no securitySchemes). A to define how the phone:read scope is expressed and how callers are identified.
- **oi-cursor-expiry** (resolved, blocking, owner: A): What the API returns for an expired cursor (HTTP status and error code) and whether the client restarts from the first page. B asked; A's human has not decided.
- **oi-offset-sunset** (resolved, blocking, owner: A): Whether cursor and limit/offset coexist, and when limit/offset and total_count are retired from the list response. No date is committed.
- **oi-phone-other-responses** (resolved, blocking, owner: A): The phone masking decision covers the list response. Order also appears in the 201 from POST /v2/orders (openapi.yaml:46-51), which B has a client wrapper for. A to say whether masking and phone:read apply to every Order-returning response, so B never receives a raw number.

## Action items

### A · alice@orders.example

- **ai-a-summary**: Orders: build GET /v2/orders/summary v1 (no filters, unfiltered count within plus or minus 1 percent) and ship it before total_count is removed from the list response. No date committed.
- **ai-a-cursor**: Orders: implement cursor pagination with the rules in the Interface section, including 410 cursor_expired, alongside limit/offset.
- **ai-a-shipping-address**: Orders: ship shipping_address (target Q1 2027, no fixed day) with 8 weeks of dual-field responses and dual-name requests, and tell B the ship date when it is set.
- **ai-a-phone**: Orders: mask customer_phone to the last 2 digits by default in every Order-returning response (list and POST /v2/orders 201) and add the phone:read scope for the support dashboard only; define how the scope is expressed and how callers are identified.
- **ai-a-spec**: Orders: update openapi.yaml to match the Interface section, including the new error code and the summary endpoint.

### B · bob

- **ai-b-cursor-loop**: Billing team: rewrite the paging loop (`src/reports/monthlyRevenue.js:16-22`) and `listOrders` (`src/clients/ordersClient.js:41-51`) to page by `cursor` and stop when `next_cursor` is null, never on `total_count`. Blocked on oi-cursor-rules.
- **ai-b-summary-count**: Billing team: take the page count for 'page N of M' (`src/reports/monthlyRevenue.js:48`) from `GET /v2/orders/summary`; approximate counts are acceptable for display. Blocked on oi-summary-contract.
- **ai-b-shipping-address**: Billing team: read `shipping_address` with fallback to `ship_to` in `src/clients/ordersClient.js:46` and `src/tax/vat.js:15`, and add a null guard at `ordersClient.js:46`, within the 8-week window that starts when Orders ships `shipping_address`. Blocked on oi-ship-date.
- **ai-b-pii**: Billing team: ensure raw phone numbers never reach B (masked or omitted); keep `OrdersApiError.body` (`src/clients/ordersClient.js:10`, `:30`) out of logs, per `docs/policies/pii.md:15`.

<!-- cma-plan
{"action_items":{"A":[{"id":"ai-a-summary","text":"Orders: build GET /v2/orders/summary v1 (no filters, unfiltered count within plus or minus 1 percent) and ship it before total_count is removed from the list response. No date committed."},{"id":"ai-a-cursor","text":"Orders: implement cursor pagination with the rules in the Interface section, including 410 cursor_expired, alongside limit/offset."},{"id":"ai-a-shipping-address","text":"Orders: ship shipping_address (target Q1 2027, no fixed day) with 8 weeks of dual-field responses and dual-name requests, and tell B the ship date when it is set."},{"id":"ai-a-phone","text":"Orders: mask customer_phone to the last 2 digits by default in every Order-returning response (list and POST /v2/orders 201) and add the phone:read scope for the support dashboard only; define how the scope is expressed and how callers are identified."},{"id":"ai-a-spec","text":"Orders: update openapi.yaml to match the Interface section, including the new error code and the summary endpoint."}],"B":[{"id":"ai-b-cursor-loop","text":"Billing team: rewrite the paging loop (`src/reports/monthlyRevenue.js:16-22`) and `listOrders` (`src/clients/ordersClient.js:41-51`) to page by `cursor` and stop when `next_cursor` is null, never on `total_count`. Blocked on oi-cursor-rules."},{"id":"ai-b-summary-count","text":"Billing team: take the page count for 'page N of M' (`src/reports/monthlyRevenue.js:48`) from `GET /v2/orders/summary`; approximate counts are acceptable for display. Blocked on oi-summary-contract."},{"id":"ai-b-shipping-address","text":"Billing team: read `shipping_address` with fallback to `ship_to` in `src/clients/ordersClient.js:46` and `src/tax/vat.js:15`, and add a null guard at `ordersClient.js:46`, within the 8-week window that starts when Orders ships `shipping_address`. Blocked on oi-ship-date."},{"id":"ai-b-pii","text":"Billing team: ensure raw phone numbers never reach B (masked or omitted); keep `OrdersApiError.body` (`src/clients/ordersClient.js:10`, `:30`) out of logs, per `docs/policies/pii.md:15`."}]},"decisions":[{"decided_by":"human-B","decided_in":"sha256:b6c1717fdefef8c5cdc1372f82290704a7955f92401ba0bfbeda5bdb9acbd3b0","id":"d-b-total-count","kind":"breaking_change","text":"B accepts cursor-only paging only if Orders provides a count another way (optional `total_count`, or a summary endpoint returning the count). Otherwise `total_count` stays. Dropping it with no replacement is not acceptable to B."},{"decided_by":"human-B","decided_in":"sha256:b6c1717fdefef8c5cdc1372f82290704a7955f92401ba0bfbeda5bdb9acbd3b0","id":"d-b-ship-to-window","kind":"deadline_commitment","text":"B accepts a dual-field read (`ship_to` and `shipping_address` both in responses) for 8 weeks from the date Orders ships `shipping_address`. Billing team owns B's migration. Orders to confirm the window and the mechanism."},{"decided_by":"human-B","decided_in":"sha256:b6c1717fdefef8c5cdc1372f82290704a7955f92401ba0bfbeda5bdb9acbd3b0","id":"d-b-phone-masked","kind":"security_or_pii","text":"B must not receive raw `customer_phone`. Masked to the last 2 digits, or omitted for B's client, is acceptable."},{"decided_by":"human-A","decided_in":"sha256:67f0c13e3441575c5189a65973acfd083eb1431555b18385eb4dad6c740d4232","id":"d-a-summary-before-removal","kind":"breaking_change","text":"Orders ships GET /v2/orders/summary returning total_count (may be approximate on unfiltered queries) BEFORE removing total_count from the list response. total_count stays in the list response until the summary endpoint is live."},{"decided_by":"human-A","decided_in":"sha256:67f0c13e3441575c5189a65973acfd083eb1431555b18385eb4dad6c740d4232","id":"d-a-ship-to-window","kind":"deadline_commitment","text":"8-week dual-field window: responses carry both ship_to and shipping_address, and requests accept both names, for 8 weeks from the date shipping_address ships. No ship date is committed yet."},{"decided_by":"human-A","decided_in":"sha256:67f0c13e3441575c5189a65973acfd083eb1431555b18385eb4dad6c740d4232","id":"d-a-phone-masked-default","kind":"security_or_pii","text":"customer_phone in the list response is masked to the last 2 digits by default. The raw number is returned only with a new phone:read scope, granted only to the support dashboard."},{"decided_by":"human-A","decided_in":"sha256:033fed864fdcf3b07cb4722f44a56bc9f1d7a4125e35a8eea261432af7c98ada","id":"d-a-ship-target","kind":"deadline_commitment","text":"Target quarter for shipping shipping_address is Q1 2027, no fixed day. The 8-week dual-field window starts on the ship date."},{"decided_by":"human-A","decided_in":"sha256:033fed864fdcf3b07cb4722f44a56bc9f1d7a4125e35a8eea261432af7c98ada","id":"d-a-summary-v1","kind":"breaking_change","text":"GET /v2/orders/summary v1 takes no filters; the unfiltered count is approximate within plus or minus 1 percent."},{"decided_by":"human-A","decided_in":"sha256:033fed864fdcf3b07cb4722f44a56bc9f1d7a4125e35a8eea261432af7c98ada","id":"d-a-cursor-rules","kind":"breaking_change","text":"next_cursor is an opaque string, valid 24 hours, ordered by created_at descending then id descending, stable within that window."},{"decided_by":"human-A","decided_in":"sha256:862b61c19d31e1d7c0ae135e65000428995d8a8c59356b6f6a5f4c7f2b588923","id":"d-a-cursor-expired","kind":"breaking_change","text":"An expired cursor returns HTTP 410 with error code cursor_expired; the client restarts from page 1."},{"decided_by":"human-A","decided_in":"sha256:862b61c19d31e1d7c0ae135e65000428995d8a8c59356b6f6a5f4c7f2b588923","id":"d-a-retirement","kind":"breaking_change","text":"limit/offset and total_count are retired from the list response no earlier than 8 weeks after GET /v2/orders/summary is live; cursor and offset coexist until then. No calendar date is committed."},{"decided_by":"human-A","decided_in":"sha256:cef5f31295f5bf7c12641d5098d0a634a723f247e505a46f260873284da92e21","id":"d-a-phone-all-responses","kind":"security_or_pii","text":"customer_phone masking (last 2 digits) and the phone:read scope apply to every response that returns an Order, including the 201 from POST /v2/orders."}],"disagreements":[],"meta":{"charter_hash":"sha256:883dafafcfd1af49fa1cc778d84f588ee5a8f61ce7ce0b0aec851a54fab76329","parties":{"A":"alice@orders.example","B":"bob"},"title":"Orders API v2: list pagination, ship_to rename and customer_phone (see docs/PLANNED_CHANGES.md)","type":"contract"},"open_items":[{"blocking":true,"id":"oi-b-call-sites","owner":"B","status":"resolved","text":"B to list its call sites of GET/POST /v2/orders: which of limit/offset, total_count, ship_to, customer_phone it reads or writes, with path:line."},{"blocking":true,"id":"oi-total-count-need","owner":"B","status":"resolved","text":"Does B depend on total_count (page counts, reconciliation)? If yes, what replaces it."},{"blocking":true,"id":"oi-ship-to-window","owner":"joint","status":"resolved","text":"Length and mechanism of the ship_to to shipping_address transition; B's migration time needed."},{"blocking":false,"id":"oi-cursor-rules","owner":"A","status":"resolved","text":"next_cursor schema, expiry and ordering guarantees to be written by A once B's paging needs are known."},{"blocking":true,"id":"oi-phone-masking","owner":"A","status":"resolved","text":"A to say whether `customer_phone` is returned raw or masked, and whether it can be masked to the last 2 digits or omitted for B's client."},{"blocking":true,"id":"oi-count-replacement","owner":"A","status":"resolved","text":"A to say how a count is provided if `total_count` is dropped (optional `total_count` or a summary endpoint). A's doc puts the summary endpoint out of scope (`docs/PLANNED_CHANGES.md:11`)."},{"blocking":false,"id":"oi-ship-to-requests","owner":"A","status":"resolved","text":"A to say whether the `ship_to` rename applies to `CreateOrderRequest` as well as responses."},{"blocking":true,"id":"oi-ship-date","owner":"A","status":"resolved","text":"The 8 weeks start when shipping_address ships; no date or target quarter is committed. A to bring a target to its human; B cannot schedule its migration until there is one."},{"blocking":true,"id":"oi-summary-contract","owner":"A","status":"resolved","text":"Summary endpoint contract: path is GET /v2/orders/summary; error bound for approximate counts on unfiltered queries, whether filtered counts are exact, and which list filters it accepts are not yet specified. B's human has not accepted approximate counts."},{"blocking":false,"id":"oi-phone-scope","owner":"A","status":"open","text":"The spec declares no auth scheme (openapi.yaml has no securitySchemes). A to define how the phone:read scope is expressed and how callers are identified."},{"blocking":true,"id":"oi-cursor-expiry","owner":"A","status":"resolved","text":"What the API returns for an expired cursor (HTTP status and error code) and whether the client restarts from the first page. B asked; A's human has not decided."},{"blocking":true,"id":"oi-offset-sunset","owner":"A","status":"resolved","text":"Whether cursor and limit/offset coexist, and when limit/offset and total_count are retired from the list response. No date is committed."},{"blocking":true,"id":"oi-phone-other-responses","owner":"A","status":"resolved","text":"The phone masking decision covers the list response. Order also appears in the 201 from POST /v2/orders (openapi.yaml:46-51), which B has a client wrapper for. A to say whether masking and phone:read apply to every Order-returning response, so B never receives a raw number."}],"parent":"sha256:3d15da7ab0282b27da6bf4af76c799d38896e8c9787ee7da9cd74cfb15ba2ea9","schema":"cma-plan/1","sections":[{"id":"context","md":"Orders team (A) changes `/v2/orders` in three ways: cursor-only pagination, `ship_to` renamed `shipping_address`, and `customer_phone` returned in the list response (`docs/PLANNED_CHANGES.md:5-23`). B (billing-service) is a consumer; its call sites are in B's implementation notes.","owner":"joint","title":"Context","type":"prose"},{"id":"interface","md":"**Current contract**\n- `GET /v2/orders`: `limit` 1-200 default 50, `offset` min 0 (`openapi.yaml:14-28`). Returns `OrderList` with required `data` and `total_count` (`openapi.yaml:108-120`).\n- `Order` requires `ship_to` (`openapi.yaml:65`) and carries nullable `customer_phone` (`openapi.yaml:87-88`).\n- `CreateOrderRequest` requires `ship_to` (`openapi.yaml:127`); optional `customer_phone` string (`openapi.yaml:131-132`).\n- `ShipTo`: `line1`, `city`, `postal_code`, `country` (`openapi.yaml:91-107`).\n\n**Cursor pagination (`GET /v2/orders`)**\n- `cursor` query parameter and `next_cursor` in the response, null on the last page (`docs/PLANNED_CHANGES.md:7-8`).\n- `next_cursor` is an opaque string. Clients must not parse it.\n- A cursor is valid for 24 hours.\n- Order is `created_at` descending, then `id` descending, stable within that 24-hour window.\n- Clients stop paging when `next_cursor` is null, never on a count.\n- Cursor and `limit`/`offset` coexist until `limit`/`offset` are retired (see Retirement).\n\n**Error contract**\n- Expired cursor: HTTP 410, error code `cursor_expired`. The client restarts from the first page.\n- Existing: HTTP 400 `invalid_order` on `POST /v2/orders` (`openapi.yaml:52-53`).\n\n**Retirement**\n- `limit`/`offset` and `total_count` are removed from the list response no earlier than 8 weeks after `GET /v2/orders/summary` is live. No calendar date is committed.\n\n**Summary endpoint (`GET /v2/orders/summary`, v1)**\n- Returns `total_count`. Takes no filters.\n- The unfiltered count is approximate, within plus or minus 1 percent.\n- Ships before `total_count` is removed from the list response.\n\n**`ship_to` to `shipping_address`**\n- Same shape (`line1`, `city`, `postal_code`, `country`) (`docs/PLANNED_CHANGES.md:16`).\n- For 8 weeks from the date `shipping_address` ships, responses carry both `ship_to` and `shipping_address`, and requests accept both names.\n\n**`customer_phone`**\n- In every response that returns an `Order`, including the list and the 201 from `POST /v2/orders` (`openapi.yaml:46-51`), `customer_phone` is masked to the last 2 digits by default.\n- The raw number is returned only with the new `phone:read` scope, granted only to the support dashboard.\n\n**Not yet specified:** how `phone:read` is expressed (`openapi.yaml` declares no security scheme).","owner":"joint","title":"Interface","type":"interface"},{"id":"a.impl_notes","md":"- Reason given for dropping `total_count`: the `COUNT(*)` query times out on the orders table at current volume (`docs/PLANNED_CHANGES.md:9-10`). unverified: no latency metric or volume figure is attached to this claim.\n- A's repo has no in-repo consumers of these endpoints. unverified: consumers outside this repo, including the support dashboard named in `docs/PLANNED_CHANGES.md:22`.\n- No auth scheme, rate limit or deprecation policy is declared in the spec.","owner":"A","title":"Implementation notes (A)","type":"prose"},{"id":"b.impl_notes","md":"**B call sites (billing-service)**\n- `src/clients/ordersClient.js:41-42`: `GET /v2/orders` sends `limit` and `offset`; page size 100 (`src/reports/monthlyRevenue.js:4`).\n- `src/clients/ordersClient.js:41-51` and `src/reports/monthlyRevenue.js:16-22`: read `total_count` for the page count and the paging-loop stop condition. Cursor-only paging means rewriting both.\n- `src/clients/ordersClient.js:46` and `src/tax/vat.js:15`: read `ship_to.country`. `ordersClient.js:46` has no null guard.\n- `POST /v2/orders` wrapper at `src/clients/ordersClient.js:53-57`. unverified: no caller found in this repo, so live use is unknown.\n- `customer_phone`: no call site in B.\n\n**B constraint**\n- B must never receive raw phone numbers. Masked to the last 2 digits, or omitted for B's client, is acceptable.\n\nB's checkout was not fetched from the remote; findings are from the local copy.","owner":"B","title":"Implementation notes (B)","type":"prose"},{"id":"rollout","md":"1. Orders ships `GET /v2/orders/summary`. `total_count` stays in the list response until it is live.\n2. Orders ships `shipping_address`, target quarter Q1 2027, no fixed day. From that date, 8 weeks of dual-field responses and dual-name requests.\n3. `customer_phone` masked by default in every Order-returning response; `phone:read` for the support dashboard only.\n4. Cursor pagination ships alongside `limit`/`offset`. Orders retires `limit`/`offset` and `total_count` no earlier than 8 weeks after the summary endpoint is live.\n\nOnly the Q1 2027 target for step 2 is a committed date. No date is committed for steps 1, 3 and 4.","owner":"joint","title":"Rollout","type":"rollout"},{"id":"risks","md":"- Dropping required `total_count` and renaming required `ship_to` break existing clients (`openapi.yaml:65`, `openapi.yaml:110-112`, `openapi.yaml:127`); both are staged behind the windows above.\n- A report that runs longer than 24 hours gets 410 `cursor_expired` and must restart from the first page.\n- The summary count is approximate (plus or minus 1 percent); it is suitable for display, not reconciliation.\n- The ship date is a target quarter only, so B cannot fix its migration dates until Orders ships `shipping_address`.\n- Masking depends on Orders identifying the caller for `phone:read`; the spec has no security scheme yet (oi-phone-scope).","owner":"joint","title":"Risks","type":"risks"}],"session":"ses_uu7iflfnfva5qjob","version":7}
-->
