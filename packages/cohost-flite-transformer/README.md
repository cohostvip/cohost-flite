# Cohost ⇄ Flite transformer

W6W app `vip.cohost.transformers.flite`, package `cohost-flite-transformer-w6w`. Converts events,
ticket types and orders between Flite and Cohost in both directions. All six actions are pure,
require no connection, and have an empty network allowlist. Flite shapes come from
`@cohost/flite-types`; the Cohost shapes in `convert/cohost-types.ts` mirror Cohost's core-types
schemas.

## Converters

| Resource | Flite → Cohost | Cohost → Flite |
| --- | --- | --- |
| Event | `fliteEventToCohost` | `cohostEventToFlite` → create/update event properties |
| Ticket type | `fliteTicketToCohost` | `cohostTicketToFlite` → create/update ticket properties |
| Order | `fliteOrderToCohost` (list item or detail) | `cohostOrderToFlite` → Flite order record |

They live in `convert/` and are exposed by two actions:

- `flite-to-cohost`: `resource` (`event`, `ticket` or `order`), the Flite record in `data`, the
  source identity, and optional `eventId`, `currency` and `organizerId`. Returns `{ data }`, plus
  `tickets` when the event includes its ticket types.
- `cohost-to-flite-data`: `resource` and the Cohost record in `data`. Returns `{ data }` in Flite's
  own field names.

Every Flite record converts and round-trips back to its original fields; the tests check this on all
the anonymized live captures and the documented examples.

### Mapping rules

- **Time.** Flite stores local `startDate`/`startTime`/`endDate`/`endTime` plus `timeZoneId`; Cohost
  stores UTC instants plus `tz`. Local times skipped by daylight saving move forward by the gap.
  Flite's original local times are kept in `meta.flite.schedule`, so an unchanged event writes back
  exactly.
- **Money.** Flite uses major units (`12.5`), Cohost uses `"USD,1250"`. Flite returns `"usd"`; Cohost
  uses upper case. Events and tickets carry no currency, so pass the organization's `currency`
  (USD by default).
- **Event status.** `isEventEnd` → `ended`, `Deleted` (a soft-deleted event) → `archived`,
  `Approved` → `live`, `Pending` → `queued`, anything else → `draft`. `public` is `Approved` and
  `showEvent`.
- **Address.** Flite state names (`New York`) become region codes (`NY`), and back. Country is `US`.
- **Description.** Flite HTML becomes plain text. The original HTML is written back unless the text
  was edited.
- **Ticket availability.** `true` → `live`, or `sold-out` once `sold >= capacity`; `hide` →
  `hidden`; `soon` → `draft`; `false` → `unavailable`. Sold-out writes back as `true`, since Flite
  derives it.
- **Order money.** `totalAmount` is what the buyer paid: Cohost `total` and `gross`. `totalCustomFee`
  is `fee`, `subtotal` is total minus fee, and `discountAmount` is `discount`.
- **Order status.** `Complete` → `placed`, `Refunded` → `refunded`, `Cancelled` → `voided`.
- **Order items.** Each issued Flite ticket (one barcode) is one item with quantity 1 and an
  `offering` snapshot. Going back, an item with quantity N becomes N Flite tickets.
- **List orders.** These carry no `eventId`, so pass it. Their tickets must have `ticketId`; live
  ones do, but the documented example does not, and those fail.
- **Order writes.** Flite has no endpoint that creates orders. `cohostOrderToFlite` is for
  comparison and export only.

## Cohost → Flite action inputs

`cohost-to-flite` accepts `resource` (`event` or `ticket`), the Cohost object in `data`, mapped
Flite `eventId`, and, for tickets, mapped `ticketId`. It returns `{ actionKey, params }`. Bind
`params` to that action in the Flite API app. It never guesses a Flite ID from a Cohost object's
`id`.

For example, a ticket with `status: "live"`, `capacity: 100`, and `costs.cost: "USD,1234"` becomes:

```json
{
  "actionKey": "update-ticket",
  "params": {
    "eventId": "mapped_flite_event",
    "ticketId": "mapped_flite_ticket",
    "availability": "true",
    "capacity": 100,
    "ticketPrice": 12.34
  }
}
```

Event `live`/`started` states become `control-event` with `action: "start"`; `draft`, `queued`,
`ended`, `completed`, `canceled`, `cancelled`, and `archived` become `stop`. This changes Flite's
ended/active flag, not publication state. A snapshot's `enabled` flag is accepted when status is
absent.

Ticket `live`/`active` becomes availability `true`, `hidden` becomes `hide`, `draft` becomes `soon`,
and `sold-out`/`unavailable`/`archived` becomes `false`. Capacity remains the total including sold tickets.
`costs.cost` (or legacy `price`) converts USD integer cents to major units, without adding
fees/taxes. Free tickets cost zero. Missing fields stay absent. Unknown states, malformed prices,
non-USD currencies, negative capacities and donation prices fail explicitly.

Only the documented Flite status, ticket capacity and pricing writes are mapped. Event/order
creation, names, descriptions, buyers and other unsupported fields are not included in action
inputs; those need additional verified API contracts.

## Other Flite → Cohost actions

| Action                 | Input                                                                     | Output                                                                   |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `transform-order`      | Full Flite `order`, source identity, optional fallback event/organizer ID | `{ order, context: { urn } }` for a Cohost import step.                  |
| `event-snapshot`       | Flite event with tickets, source identity                                     | `{ snapshot }` with ticket price, availability, capacity and sold count. |
| `list-mapping-objects` | Full Flite `event`, source identity                                       | `{ objects }` with ticket IDs, names and source URNs.                    |

Source identity is the owning Cohost `companyId` and original Cohost `connectionId`. Reuse these to
preserve mappings and deduplication; the W6W connection ID is a different identifier. URNs use
`urn:1:{companyId}:{connectionId}:/events/{id}` and related ticket/order paths.

`transform-order` is `flite-to-cohost` for orders, kept for existing workflows. The snapshot
treats an event as enabled when it is `Approved` and not ended.

## Legacy migration

- `orders_list`: API `list-orders` → this app's `transform-order` per order.
- `import_order` / `import_orders`: fetch and paginate → transform → authenticated Cohost import
  step.
- `event_snapshot`: API `get-event` → this app's `event-snapshot`.
- `list_mapping_objects`: API `get-event` → this app's `list-mapping-objects`.
- `map_object`: Cohost mapping API, using source URNs from this app.
- `event_actions`, `register_webhook`, `webhook`: API app `control-event`, `register-webhook`, and
  `order-placed` trigger respectively.

## Build

Build and test from the repo root (`npm run build`), then install the built
`dist/packages/cohost-flite-transformer`, not this source folder. The release has no dependencies and runs without either API app.
