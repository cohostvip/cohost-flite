# Anonymized live Flite fixtures

Real Flite Partner API response shapes, captured from production on 2026-11-12 (partner
sessions on 2026-11-13) and anonymized for committing. The `staging-*` files and `webhook-url`
were captured on 2026-11-20: a throwaway event and ticket created, changed and deleted on Flite
staging, scanner calls against a staging ticket, and the production webhook read. Both packages load them through `tests/live-fixtures.ts`.

| Shape | File | Endpoint |
| --- | --- | --- |
| Login (session) | `login.response.json` | `POST /api/partner-login` |
| Refreshed session | `partner-refresh-token.response.json` | `POST /api/partner-refresh-token` |
| Refresh errors | `partner-refresh-token-{missing,invalid,after-revoke}.response.json` | same; HTTP 400/401 with `code` |
| Revoke | `partner-revoke-token{,-invalid}.response.json` | `POST /api/partner-revoke-token` |
| Bad access token | `invalid-access-token.response.json` | any partner route; HTTP 401 |
| Organizations | `organizations-partner.response.json` | `GET /api/get-all-orgs-partner` |
| Events page (9 events) | `events-page-1.response.json` | `GET /api/get-events-all` |
| Event | `event-1.response.json` | `GET /api/get-event-by-id` |
| Event + ticket types | `event-1-with-tickets.response.json` | `GET /api/get-event-tickets-info` |
| Ticket type | `event-1-ticket-{1,2}.response.json` | `GET /api/get-ticket-by-id` |
| Orders page | `event-9-orders-page-1.response.json` | `GET /api/get-orders-by-event` |
| Order detail | `event-9-order-1.response.json` | `GET /api/get-order-by-id` |
| No orders (HTTP 404) | `event-{1..8}-orders-page-1.response.json` | `GET /api/get-orders-by-event` |
| Webhook URL | `webhook-url.response.json` | `GET /api/get-webhook-url` (`data.webhookUrl`) |
| Staging events page | `staging-events-page-1.response.json` | `GET /api/get-events-all` |
| Created event (HTTP 201) | `staging-event-created.response.json` | `POST /api/create-event-partner` (multipart) |
| Create rejected (HTTP 400) | `staging-event-create-invalid.response.json` | same, missing fields |
| Event, after delete, unauthorized | `staging-event{,-after-delete,-unauthorized}.response.json` | `GET /api/get-event-by-id` |
| Event updated / no change | `staging-event-updated`, `staging-event-update-unchanged` | `POST /api/update-event-properties` |
| Event ended / reopened | `staging-event-{ended,reopened}.response.json` | `POST /api/update-event-end-toggle` |
| Event deleted | `staging-event-deleted.response.json` | `DELETE /api/delete-event-partner` |
| Event + tickets | `staging-event-with-tickets.response.json` | `GET /api/get-event-tickets-info` |
| Ticket created / rejected | `staging-ticket-created`, `staging-ticket-create-invalid` | `POST /api/create-new-ticket` |
| Ticket, after delete (HTTP 404) | `staging-ticket{,-not-found}.response.json` | `GET /api/get-ticket-by-id` |
| Ticket updated | `staging-ticket-updated.response.json` | `POST /api/update-ticket-properties` |
| Ticket deleted | `staging-ticket-deleted.response.json` | `DELETE /api/delete-ticket-partner` |
| Scanner validate | `staging-scan-validate{,-not-found,-checked-in}.response.json` | `POST /api/scanner/ticket/validate`; HTTP 200/404/409 |
| Scanner check-in | `staging-scan-checkin{,-not-found,-repeat}.response.json` | `POST /api/scanner/ticket/checkin`; HTTP 200/404/409 |
| Ticket types (derived) | `ticket-types.derived.json` | from the two ticket responses |
| Attendees (derived) | `attendees.derived.json` | buyer + issued ticket from the order |

Each `*.response.json` is `{ status, body }`: the HTTP status and the exact response body.

Note that the order list and order detail return different fields for the same order: the list
omits `eventId`, and only the list's tickets carry `promoterAmount`/`discountAmount`. The only
captured order is a free one (`totalAmount: 0`); for paid orders, use `samples/documented/`.

## What was anonymized

- **Kept as captured:** keys, nesting, types, nulls and empty values; money, counts and booleans;
  `currency` (`"usd"`, lowercase), `timeZoneId`, `startTime`/`endTime`, `state`, `gender`,
  `status`, `availability`, `rsvpType`, `transferStatus`, scanner `validityStatus`/`errorCode`/
  `rejectionReason`, and API `message` and error `code` strings.
- **Synthetic, same format:** ObjectIds (`65f1e…`, still 24 hex characters), UUIDs, barcodes and
  scanner ticket numbers,
  event codes, order numbers, transaction and tracking IDs, ZIP codes. Repeated values map to the
  same replacement across files.
- **Synthetic text:** people (`alex.rivera@example.com`, `+1 202-555-01xx`), organization, event,
  venue, city, ticket names and descriptions; HTML descriptions stay HTML.
- **Dates:** shifted forward 52 weeks, so weekdays and intervals are preserved.
- **Removed:** tokens (placeholders only), request URLs, headers and capture metadata.

`packages/flite/tests/fixtures-anonymized.test.ts` fails CI if a real email, URL, ObjectId, phone
number or token reaches these files.

## Regenerating

Raw captures stay in the Git-ignored `.local/`. To regenerate from a new capture:

```sh
node scripts/anonymize-fixtures.mjs .local/samples/<capture-directory>
npm test
```

The script makes no network calls and reads no env files. It refuses to run if a capture has a
string field it has no rule for, and writes nothing if any original identifying value would
appear in the output. Review the diff before committing.
