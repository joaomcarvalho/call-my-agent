# orders-service

Order management API. Owned by the **Orders team**.

## What it does

- Stores customer orders with status, amount, currency and shipping address.
- Serves the list and create endpoints under `/v2`.
- The contract lives in `openapi.yaml`; it is the source of truth for consumers.

## Endpoints

| Method | Path        | Purpose                          |
|--------|-------------|----------------------------------|
| GET    | `/v2/orders` | List orders (offset pagination) |
| POST   | `/v2/orders` | Create an order                 |

## Layout

- `openapi.yaml`: API contract (OpenAPI 3.1).
- `src/routes/orders.js`: Express handlers for the `/v2/orders` routes.
- `docs/PLANNED_CHANGES.md`: the team's plan for the next API revisions.

## Contacts

Orders team, `#orders` on Slack.
