# billing-service

Generates customer invoices and the monthly revenue report from orders. Owned by the
**Billing team**.

## What it does

- Reads orders from the orders-service `GET /v2/orders` endpoint.
- Computes VAT for each order from the shipping country.
- Produces monthly revenue reports with page-level summaries.
- Creates order adjustments through `POST /v2/orders` when a refund or correction is booked.

## Layout

- `src/clients/ordersClient.js`: HTTP client for the orders-service API.
- `src/reports/monthlyRevenue.js`: monthly revenue report.
- `src/tax/vat.js`: VAT rate lookup.
- `docs/policies/pii.md`: personal data rules that apply to this service.

## Contacts

Billing team, `#billing` on Slack.
