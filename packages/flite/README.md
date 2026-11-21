# Flite API app

W6W app `vip.cohost.flite`, package `flite-w6w`. Seventeen API actions, one for each Flite Partner API endpoint, and one order webhook trigger.
Cohost conversions live in `vip.cohost.transformers.flite`.

## Authentication

Choose **Flite Account** for `api-main.fliteapi.city`, or **Flite Account (Staging)** for
`api-staging.fliteapi.city`. Enter the email and password of a verified Flite Pilot account. To
manage an organization other than the account's first, also enter its name or ID.

- **Connect** calls `POST /api/partner-login` once. If you named another organization, it then calls
  `POST /api/switch-organization-token/{id}`. Only the session is stored: the access token, the
  refresh token and their expiry times. The password is not stored.
- **Renewal.** Access tokens last 7 days. The stored `expiresAt` is a day earlier, and W6W calls
  `refresh` (`POST /api/partner-refresh-token`) once it comes due. Each refresh rotates both tokens.
  Two refreshes at once are safe: the old refresh token returns the same new pair for 5 minutes.
- **Expiry.** The refresh token lasts 30 days from the last refresh. W6W refreshes when it uses the
  connection, so a connection unused for 30 days must be reconnected. So must one whose password
  changed, or whose user left the organization.
- **Disconnect** calls `POST /api/partner-revoke-token`, which ends this session only. Other
  logins for the same user are unaffected.

**Bearer Token (Production/Staging)** remains for existing connections: paste an access token. It
expires after 7 days and is not renewed.

Actions never read credentials. Isolated auth hooks sign requests only for the selected
environment, and always with the access token, never the refresh token. Credential testing uses
`GET /api/get-all-orgs-partner`. Errors carry Flite's error `code`, such as `refresh_token_reused`
or `org_access_revoked`, never the response body. A revoked refresh token also answers
`refresh_token_reused`.

## Actions

| Key                  | Type    | Flite endpoint                                       | Behavior |
| -------------------- | ------- | ---------------------------------------------------- | -------- |
| `list-organizations` | read    | `GET /get-all-orgs-partner`                          | The account's organizations. |
| `list-events`        | search  | `GET /get-events-all`                                | One page of events; filter by status (`Approved`, `Pending`), date, name search; up to 40 per page. |
| `get-event`          | read    | `GET /get-event-tickets-info`, `GET /get-event-by-id` | The event with its ticket types, or alone with `includeTickets: false`. Deleted events return status `Deleted`. |
| `create-event`       | perform | `POST /create-event-partner`                         | Creates an event; uploads the `flyer` file param (PNG/JPEG/GIF/WebP) as multipart. |
| `update-event`       | perform | `POST /update-event-properties`                      | Name, description, venue, city, dates, times, visibility, RSVP capacity; only fields set are sent. |
| `control-event`      | perform | `POST /update-event-end-toggle`, `POST /update-ticket-properties` | Start/stop an event or ticket; optionally ticket capacity and a `USD,1234` minor-unit price. |
| `delete-event`       | perform | `DELETE /delete-event-partner`                       | Soft delete. Flite refuses events with held or completed orders. |
| `get-ticket`         | read    | `GET /get-ticket-by-id`                              | One ticket type, with `sold`. A deleted ticket is HTTP 404. |
| `create-ticket`      | perform | `POST /create-new-ticket`                            | Adds a ticket type; price in major USD units. |
| `update-ticket`      | perform | `POST /update-ticket-properties`                     | Name, price, total capacity (including sold), availability (`true`, `false`, `hide`, `soon`), description, max per cart. |
| `delete-ticket`      | perform | `DELETE /delete-ticket-partner`                      | Soft delete; also removes it from coupons. |
| `list-orders`        | read    | `GET /get-orders-by-event`                           | One page of an event's completed orders, optional page size. |
| `get-order`          | read    | `GET /get-order-by-id`                               | A full order with buyer and tickets. |
| `validate-ticket`    | read    | `POST /scanner/ticket/validate`                      | Scanner check without check-in. |
| `check-in-ticket`    | perform | `POST /scanner/ticket/checkin`                       | Validates and checks in. |
| `get-webhook`        | read    | `GET /get-webhook-url`                               | The organization's webhook URL, or `null`. |
| `register-webhook`   | perform | `PUT /update-webhook-url`                            | Registers an HTTPS callback; replacing a different URL needs `replaceExisting`. |

Resource inputs accept IDs or matching source URNs. Follow `pagination.nextPage` (orders) or the
next `page` (events) while `pagination.hasMore` is true. “No completed orders found” yields an empty
list. HTTP/application failures throw so W6W can report and retry them; the error names the endpoint
and HTTP status but never echoes the response body. Inputs are checked against Flite's documented
rules first (dates `YYYY-MM-DD`, times `HH:mm`, nonnegative prices and capacities), so a bad field is
named in the error instead of surfacing as an opaque HTTP 400.

**Scanner verdicts.** `validate-ticket` and `check-in-ticket` take the link from the ticket QR code
as scanned, or a ticket barcode (an order's `tickets[].barcode`), which becomes
`https://flite.city/Tickets/<barcode>/scan`. They return `valid`, `checkedIn`, `errorCode` and the
full `result`. Flite answers an unknown ticket with HTTP 404 (`TICKET_NOT_FOUND`) and a used one
with HTTP 409 (`ALREADY_CHECKED_IN`); both are returned as `valid: false`, not errors.
`check-in-ticket` is not idempotent: a retry after a successful check-in reports
`ALREADY_CHECKED_IN`.

**Flyer upload.** `create-event` reads the flyer through the host's `ctx.file` and sends the
multipart body as bytes, because the sandbox carries request bodies only as text or bytes. On a host
without file access it fails with a clear error and sends nothing.

Authentication endpoints (`partner-login`, `partner-refresh-token`, `partner-revoke-token`,
`switch-organization-token`) are the connection's auth hooks, not actions.

## Order Placed trigger

1. Create an `order-placed` subscription with this app's connection.
2. Copy the callback URL W6W issues.
3. Call `register-webhook` with that URL. Set `replaceExisting: true` only to replace the existing
   consumer: Flite supports one URL per organization.
4. Use the full `order` output in workflow steps.

POST JSON with `action: "order-placed"` and `orderId` emits an event. Test pings and unknown event
types emit nothing. Missing order IDs fail ingestion. The output hook fetches the order through the
authenticated API rather than trusting order details in the body.

The supplied API contract documents neither webhook signatures nor a delete URL endpoint.
Registration is explicit; deleting a W6W subscription does not clear Flite's URL. Replace it when
retiring the subscription. Keep the callback private and deduplicate downstream writes by source
order URN.

## Build

Build and test from the repo root (`npm run build`), then install the built `dist/packages/flite`,
not this source folder. The release has no dependencies. The icon is Flite's favicon (flite.city), resized to 128×128. The ISC license is inherited from the original runtime app.
