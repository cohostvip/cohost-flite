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
| `create-event`       | perform | `POST /create-event-partner`                         | Creates an event as multipart; the optional `flyer` file param (PNG/JPEG/GIF/WebP) is uploaded as `hostFlyer`. |
| `update-event`       | perform | `POST /update-event-properties`                      | Name, description, venue, city, state, ZIP code, dates, times, visibility, RSVP capacity; only fields set are sent. Event status (`Approved`/`Pending`) is read-only. |
| `control-event`      | perform | `POST /update-event-end-toggle`, `POST /update-ticket-properties` | Start/stop an event or ticket; optionally ticket capacity and a `USD,1234` minor-unit price. |
| `delete-event`       | perform | `DELETE /delete-event-partner`                       | Soft delete. Flite refuses events with held or completed orders. |
| `get-ticket`         | read    | `GET /get-ticket-by-id`                              | One ticket type, with `sold`. A deleted ticket is HTTP 404. |
| `create-ticket`      | perform | `POST /create-new-ticket`, `POST /update-ticket-properties` | Adds a ticket type; price in major USD units. Flite's create ignores max per cart, so `maxCart` is set by a follow-up update. |
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
rules first (dates `YYYY-MM-DD`, times `HH:mm`, nonnegative prices in whole cents, nonnegative
integer capacities, max per cart of at least 1), so a bad field is named in the error instead of
surfacing as an opaque HTTP 400. Local checks matter more than the reference suggests: Flite answers
an unknown or ignored field, and an empty update, with HTTP 200 `No changes detected`, and stores a
sub-cent price such as `10.005` as sent.

**Ticket defaults and limits.** Flite sets capacity 2000, availability `true` and max per cart 10
when a create leaves them out. It has no minimum per cart and no fee or delivery fields: fees are
set per order (`totalCustomFee`), not on a ticket type. Capacity cannot drop below the number sold
(HTTP 400). If `create-ticket`'s max-per-cart update fails, the error names the created ticket; set
the value with `update-ticket` rather than running `create-ticket` again, which would add a second
ticket type.

**Scanner verdicts.** `validate-ticket` and `check-in-ticket` take the link from the ticket QR code
as scanned, or a ticket barcode (an order's `tickets[].barcode`), which becomes
`https://flite.city/Tickets/<barcode>/scan`. They return `valid`, `checkedIn`, `errorCode` and the
full `result`. Flite answers an unknown ticket with HTTP 404 (`TICKET_NOT_FOUND`) and a used one
with HTTP 409 (`ALREADY_CHECKED_IN`); both are returned as `valid: false`, not errors.
`check-in-ticket` is not idempotent: a retry after a successful check-in reports
`ALREADY_CHECKED_IN`.

**Flyer upload.** The flyer is optional: Flite's reference calls it required, but Flite creates the
event without one (`hostFlyer: []`). Without a flyer, `create-event` sends the text fields only and
needs no file access. With one, it reads the flyer through the host's `ctx.file` and sends the
multipart body as bytes, because the sandbox carries request bodies only as text or bytes; on a host
without file access it then fails with a clear error and sends nothing.

Authentication endpoints (`partner-login`, `partner-refresh-token`, `partner-revoke-token`,
`switch-organization-token`) are the connection's auth hooks, not actions.

## Order Placed trigger

A manual webhook (`webhook.registration: "manual"`) on Flite Partner Webhooks
(`docs/api-docs.md`, "Webhooks"):

1. Put the trigger on a step. The editor shows the receive URL right away; the empty Signing Secret
   does not block creating the subscription.
2. In Flite, open Integrations → Developers → Webhooks → Register Webhook, paste that URL, choose
   the event source and the events (`order.completed`, plus `order.refunded`, `order.updated` and
   `order.scan` to keep orders in sync).
3. Copy the signing secret Flite shows (`fsec_live_…`, shown once) into the trigger's **Signing
   Secret** (`signingSecret`, `type: "secret"`, encrypted at rest) and save. The URL stays the same.
4. Use the full `order` output in workflow steps.

Flite posts `{ webhookEventId, eventType, orderId, organizationId, eventId, created }` with
`X-Flite-Signature: sha256=<hex>` and `X-Flite-Timestamp`. `handleIngest` recomputes
`HMAC-SHA256(secret, timestamp + "." + body)` over the raw body (Web Crypto, constant-time compare,
`lib/webhook.ts`) and refuses a delivery that does not match, is older than five minutes, or
arrives before the secret is set. `order.completed`, `order.refunded`, `order.updated`,
`order.disputed` and `order.scan` emit an event; `order.created` (a pending checkout) and unknown
types emit nothing. The output hook fetches the order through the authenticated API rather than
trusting the body. Flite delivers at least once: dedupe on `webhookEventId`, and downstream writes
by source order URN.

If the secret is rolled in Flite the old one stops working immediately: paste the new one into the
trigger. `register-webhook` / `get-webhook` drive Flite's older per-organization webhook URL API,
which is separate from the signed Partner Webhooks registered in the Flite UI.

## Build

Build and test from the repo root (`npm run build`), then install the built `dist/packages/flite`,
not this source folder. The release has no dependencies. The icon is Flite's favicon (flite.city), resized to 128×128. The ISC license is inherited from the original runtime app.
