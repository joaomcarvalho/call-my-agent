# Planned changes: Orders API

Owner: Orders team. Status: proposed for the next quarter.

## 1. Cursor-only pagination for `GET /v2/orders`

- Replace `limit`/`offset` with a `cursor` query parameter.
- Responses return `next_cursor` (null on the last page).
- Drop `total_count` from the list response. The `COUNT(*)` query times out on the
  orders table, so the field cannot be served reliably at current volume.
- Consumers that need a total should use a summary endpoint instead (not in scope here).

## 2. Rename `ship_to` to `shipping_address` in v2

- The field is renamed to `shipping_address` in the next API revision.
- The object shape (line1, city, postal_code, country) stays the same.
- `ship_to` remains readable for one release after the rename.

## 3. Add `customer_phone` to the list response

- `customer_phone` is added to each order in `GET /v2/orders`.
- It is needed by the support dashboard. The field is already in the openapi.yaml spec
  for `Order`; this change makes the list endpoint return it consistently.
