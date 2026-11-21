# Documented Flite payload samples

These are **documentation examples, not live API captures**. They were extracted
from the successful JSON responses in Flite's API reference
(https://www.flite.city/docs), as captured on 2026-11-12. `manifest.json` records each example's source anchor.

| File | Payload |
| --- | --- |
| `organizations.json` | Partner organization listing |
| `events-page.json` | Paginated organization events |
| `event.json` | Event details |
| `event-with-tickets.json` | Event with its ticket types |
| `ticket.json` | Single ticket type |
| `orders-page.json` | Paginated event orders with buyers and issued tickets |
| `order.json` | Single order, buyer, issued tickets, check-in/transfer fields |
| `attendees.derived.json` | Ticket/attendee records extracted from `order.json`; buyer is order-level |
| `ticket-validation.json` | Example response from validation without check-in |

The reference does not document a separate attendee-list endpoint. Issued tickets,
barcodes and check-in data appear under order `tickets`; ticket types are separate
objects returned by the event/ticket endpoints.

Live responses are stored separately under Git-ignored `.local/samples/`. The
current token successfully lists organizations through `/api/get-all-orgs`, but
the documented partner endpoints reject it. Corrected calls to
`GET /api/get-all-orgs-partner`, `GET /api/get-events-all`, and
`POST /api/switch-organization-token/{organizationId}` also returned HTTP 401.
No example login password was used and no data-write endpoints were called.
