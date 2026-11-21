# @cohost/flite-types

Types for the Flite Partner API, shared by the `flite` and `cohost-flite-transformer` apps. Import
them with `import type`; they are erased at build time, so neither app bundle depends on this
package.

- `responses.ts`: response payloads (`FliteEvent`, `FliteEventWithTickets`, `FliteTicket`,
  `FliteOrder`, `FliteOrderListItem`, `FliteBuyer`, …), derived from the anonymized live captures in
  `tests/fixtures/live` and the documented examples in `samples/documented` by
  `scripts/derive-types.mjs`. Do not edit it by hand.
- `index.ts`: the response envelope, webhook delivery, and request bodies (`FliteCreateEventInput`,
  `FliteUpdateTicketInput`, …), written from Flite's API reference (https://www.flite.city/docs).

## How the types are derived

A field is required when every live sample has it. Fields seen only in the documentation are
optional and marked "Documented only". Fields only ever seen as `null` are typed `string | null`
and marked as assumed. Enum-like strings list the values observed. A few contracts the JSON cannot
express (ticket `availability`, question answers, `instaHandles`) are set in `OVERRIDES` in the
script.

After adding or refreshing a capture:

```sh
npm run types   # rewrite responses.ts
npm test        # fails if responses.ts is out of date with the JSON
```
