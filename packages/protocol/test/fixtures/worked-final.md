# Order list API for billing

contract · version 2 · session `ses_fixture_orders_billing` · A: alice@orders.example · B: billing team · charter `sha256:fce92a89b08912119c8d69214c745a4ed5e1d331a3cba90186d59e6592ffdbf9`

## Decisions

| ID | Decision | Kind | Decided by | Decided in |
| --- | --- | --- | --- | --- |
| D2 | Responses include `total_count` so billing can detect truncated syncs. | — | agent-assumed | `sha256:0f4cdff10084ce3ae07bf89ec6c7746e585cd7f1f3055d9950572cdc8358aeb5` |
| D1 | List endpoints use opaque cursor pagination instead of offsets. | — | human-A | `sha256:0f4cdff10084ce3ae07bf89ec6c7746e585cd7f1f3055d9950572cdc8358aeb5` |
| D3 | Rename `amount` to `amount_minor` (integer minor units). Breaking for existing consumers. | breaking_change | human-A | — |

## Context

_Section `context` · prose · owner: joint_

Billing reconciles invoices against orders every night and needs a stable way to page through all orders.

## Interface

_Section `interface` · interface · owner: joint_

`GET /v1/orders` pages with an opaque `cursor`; responses carry `next_cursor` (null on the last page) and `total_count`.

**Artifact `orders-list`** · openapi-3.1 · `sha256:dfbad53e3d089f1764b192a6c2cbfde0dc4e2a340542b0dcf6aa03425a2ff46f`

```openapi-3.1
paths:
  /v1/orders:
    get:
      parameters:
        - name: cursor
          in: query
          schema: { type: string }
      responses:
        '200':
          description: A page of orders
          content:
            application/json:
              schema:
                type: object
                required: [orders, next_cursor, total_count]
                properties:
                  orders: { type: array, items: { $ref: '#/components/schemas/Order' } }
                  next_cursor: { type: [string, 'null'] }
                  total_count: { type: integer }
components:
  schemas:
    Order:
      type: object
      required: [id, amount_minor, currency]
      properties:
        id: { type: string }
        amount_minor: { type: integer, description: Amount in minor units }
        currency: { type: string }
```

## Implementation notes (A)

_Section `a.impl_notes` · prose · owner: A (alice@orders.example)_

Dual-write `amount` and `amount_minor` for 30 days, then drop `amount`.

## Implementation notes (B)

_Section `b.impl_notes` · prose · owner: B (billing team)_

_No content._

## Rollout

_Section `rollout` · rollout · owner: joint_

1. Orders ships `amount_minor` next to `amount`.
2. Billing switches to `amount_minor` and cursor pagination.
3. Orders removes `amount` 30 days later.

## Risks

_Section `risks` · risks · owner: joint_

Any consumer still reading `amount` after day 30 breaks. Billing is the only known consumer.

## Disagreements

- **X1**: Billing asked to keep `amount` indefinitely.
  Resolution: Dropped after the 30-day dual-write window.

## Open items

- **OI1** (resolved, blocking, owner: joint): Agree how `amount` changes before billing switches over.

## Action items

### A · alice@orders.example

- **A1**: Add `amount_minor` and `total_count` to `GET /v1/orders`.

### B · billing team

- **B1**: Move the nightly sync to cursor pagination and `amount_minor`.
