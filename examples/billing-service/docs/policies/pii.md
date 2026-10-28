# Personal data policy: billing-service

Billing must not store or receive raw customer phone numbers. Phone numbers may only
appear masked (last 2 digits).

Examples:

- Allowed: `+** ** *** **34` (only the last 2 digits visible).
- Not allowed: any field, log line, report or export that contains a full phone number.

Applies to:

- Responses received from the orders-service API.
- Invoices, revenue reports and exports produced by this service.
- Application logs and error payloads.
