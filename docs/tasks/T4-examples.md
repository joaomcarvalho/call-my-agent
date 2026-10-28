# T4 · Example repos with planted conflicts

**Owns:** `examples/**` only. Do not touch anything else. No `package.json` dependencies need installing; the code only has to be readable and plausible, not runnable.

Two small, realistic services. Each one is the working directory of one Claude Code agent, so everything an agent needs to discover a conflict must be in its own folder. **Neither folder may mention the other side's conflicts or this task.** No comments like "planted conflict" or "TODO: conflict".

## examples/orders-service (producer, party A)

- `README.md`: what the service does (order management API), owner team "Orders team".
- `openapi.yaml`: OpenAPI 3.1 for `GET /v2/orders` (query `limit`, `offset`; response `{data: Order[], total_count: integer}`) and `POST /v2/orders`. `Order` has `id`, `status`, `created_at`, `amount_cents`, `currency`, `customer_id`, `customer_phone`, `ship_to` (object: line1, city, postal_code, country).
- `src/routes/orders.js`: Express handlers matching the spec. The list handler uses offset pagination and runs a `COUNT(*)` query for `total_count` with a code comment that it is slow on large tables. `POST` has no idempotency handling.
- `docs/PLANNED_CHANGES.md`, written as the team's own plan:
  1. Move `GET /v2/orders` to cursor-only pagination (`cursor`, `next_cursor`) and **drop `total_count`** because the count query times out.
  2. **Rename `ship_to` to `shipping_address`** in v2 next quarter.
  3. Add `customer_phone` to the list response for the support dashboard (already in the spec).

## examples/billing-service (consumer, party B)

- `README.md`: generates invoices and a monthly revenue report from orders; owner team "Billing team".
- `src/clients/ordersClient.js`: calls `GET /v2/orders` with `limit`/`offset`, reads `total_count` to compute page count, and reads `order.ship_to.country` for tax calculation. `createOrderAdjustment` POSTs to `/v2/orders` and **retries up to 3 times on timeout** with no idempotency key.
- `src/reports/monthlyRevenue.js`: renders "Showing page X of Y (N orders)" using `total_count`.
- `src/tax/vat.js`: uses `ship_to.country` to pick a VAT rate.
- `docs/policies/pii.md`: "Billing must not store or receive raw customer phone numbers. Phone numbers may only appear masked (last 2 digits)."

## Acceptance criteria (the orchestrator checks these with grep)

- **AC1** `grep -r "total_count" examples/billing-service/src` finds at least 2 files; `grep -r "ship_to" examples/billing-service/src` finds at least 2 files.
- **AC2** `examples/orders-service/docs/PLANNED_CHANGES.md` mentions `cursor`, `total_count`, `shipping_address`, `customer_phone`.
- **AC3** `examples/billing-service/docs/policies/pii.md` forbids raw phone numbers.
- **AC4** `ordersClient.js` retries POST on timeout; `orders.js` has no idempotency key handling (`grep -ri idempot examples/orders-service` finds nothing).
- **AC5** `grep -riE "conflict|planted|TODO" examples/` finds nothing.
- **AC6** `examples/orders-service/openapi.yaml` parses as YAML (`bun -e "require('yaml')"` is not available; instead keep it simple, consistent 2-space indentation, and the orchestrator will parse it).
- **AC7** Each file is under 150 lines.
