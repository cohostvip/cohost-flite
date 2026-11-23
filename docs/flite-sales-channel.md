# Flite sales channel (internal)

A Cohost company-owned, non-public API channel mirrors its events onto Flite. A four-root w6w workflow
re-reads current Cohost truth on every trigger and reconciles Flite against it; a third root imports inbound Flite orders (see Orders) and a fourth, detached root backfills all orders on demand (see Order import (backfill)). It only ever creates,
updates, stops and reopens; it never deletes anything on Flite.

## Pipeline

One channel-scoped root (further roots, for orders and import, are described below): the single `channel-changed` trigger, with `actions` `event.change` / `ticket.change` (payload `action` says which; ticket changes pass only for events listed on the channel).
It takes a `channelId` param, so tickets of unrelated events never start a run. It feeds the snapshot step directly
(payload `meta.{channelId, eventId, companyId, …}`), then:

1. `get-channel-event-snapshot` (app `vip.cohost.w6w`) — channel view, owner event + tickets, listing, RMS mappings.
2. `channel-event-to-flite` (`vip.cohost.transformers.flite`) — pure: snapshot → desired Flite state.
3. `sync-event` (`vip.cohost.flite`) — reconciles desired state against Flite and the mappings.
4. `register-urn-mappings` (retry 3) — persists `sync-event`'s `registrations`.
5. `report` (`@w6w/script`) — fails the run iff `sync-event` returned `errors`. It runs after step 4, so mappings are saved even when the run fails.

Workflow file: `workflows/flite-sales-channel.workflow.json`. It holds no ids, tokens or credentials; connections are refs bound at install.

## Orders

A third root imports inbound Flite orders: the Flite app's `order-placed` trigger (`order_placed`, a signed manual Partner Webhook: paste the Flite signing secret into the trigger's Signing Secret) -> `order_transform` (`transform-order`) -> `order_upsert` (`upsert-order`, `vip.cohost.w6w`, retry 3). Flite and Cohost connections are bound at install like the other nodes.

- **One Flite connection.** `transform-order.connectionId` is the Flite step's own connection (`steps.order_placed.meta.connectionId`; the import uses `steps.import_conn.meta.connectionId`). It is the URN source segment, the same one `sync-event` registers mappings under. No connection, no transform. `companyId` is the hidden const `{{ const.account_id }}`, exactly as in the Eventbrite transformer; it is never a workflow field or variable.
- **Full upsert body.** `transform-order` outputs `data = { order, source, attendees }`, and `upsert-order.data` binds that whole object:
  - `order`: the converted order (URN, event `contextId`, items, buyer, costs, `paymentMethod: "deferred"`), with `context.channelId` = the selling channel (`vars.channelId`) and `context.source: "flite"`.
  - `source`: `{ system: "flite", externalId: <Flite order _id>, eventId: <Flite event id>, urn, changedAt, status, payload: <raw Flite order> }`. `account` is left to Cohost, which takes it from the URN's connection segment.
  - `attendees`: one per issued Flite ticket: `{ orderItemId, index: 0, urn, profile: null (Cohost uses the buyer), barcodes: [barcode], checkedIn, status }`.
- **No event id field.** The Flite event id comes from the order: detail orders carry `eventId`, and `order-import-flatten` stamps it on list orders.

- **Deferred payment.** The converter always emits `paymentMethod: "deferred"`, for paid, free and refunded Flite orders alike: Flite collected the money. Amounts stay in cents, with currency, payment date, line items and buyer from the Flite order.
- **Cohost side.** `POST /orders` strips a client-supplied `paymentMethod` except exactly `"deferred"` from a connection-authenticated write (cohost `packages/domains/bll/orders/src/orders/provenance.ts` `deferredPaymentMethod`, used by `create.ts`). This workflow writes through the Cohost connection, so its orders are stored as deferred; a buyer or dashboard write still cannot set the method.
- **Idempotency.** The order URN is `urn:1:<companyId>:<fliteConnectionId>:/orders/<id>`. The root calls `upsert-order`, never a create action, so a retry updates the same order and never duplicates it.
- **No URN pre-resolve.** The order root does not resolve the order's event URN itself. `POST /v1/orders` resolves the remote-URN `contextId` (and ticket URNs) through the mapping before persisting, and refuses an unresolvable or other-company one with 404. The validator rejects any `resolve-urn` step or extra step on the order path.
- **Out of scope.** Refunds and cancellations.

## Order import (backfill)

A fourth root, detached from the other three (no edges to or from the event, ticket or order-placed roots; it shares only `vars` and the `cohost` / `flite` connections, both bound at install), imports ALL existing Flite orders of a channel's mapped events into Cohost.

- **Root shape.** `import_start` (`@w6w/trigger` `manual`) -> `import_list_events` (`list-channel-events`) -> `import_event_ids` (script) -> `import_each_event` (foreach: `ev_snapshot` -> `ev_target`) -> `import_pages` (`order-import-pages`) -> `import_each_page` (foreach: `page_fetch`, Flite `list-orders`, retry 3) -> `import_flatten` (`order-import-flatten`) -> `import_complete` (guard script) -> `import_each_order` (foreach: `imp_transform` (`transform-order`) -> `imp_upsert` (`upsert-order`, retry 3)). `validateImportRoot` in `scripts/workflow.ts` pins this shape.
- **How to start.** Manual only. It imports every event on the channel; `maxPages` (literal 10) bounds paging. No new env vars.
- **Pagination.** Flite `list-orders` returns `pagination.hasMore` / `nextPage`. The engine has no while-loop, so paging is a bounded foreach over pages 1..`importMaxPages` per event. Flatten consumes every page and marks an event truncated when its last fetched page still has `hasMore` or a non-null `nextPage`; `import_complete` then throws before any upsert, so nothing is imported for a truncated run.
- **Idempotency.** Each order gets the stable URN `urn:1:<companyId>:<fliteConnectionId>:/orders/<id>` and `paymentMethod: "deferred"` from `transform-order`; `imp_upsert` is `upsert-order`, so re-running imports nothing twice. Orders are also de-duplicated by Flite `_id` per event before upsert.
- **Skip rules.** An event is imported only if exactly one mapping has the URN `urn:1:<companyId>:<fliteConnectionId>:/events/<id>` (this Flite connection; `companyId` from the snapshot) AND its labels equal `{provider: flite, channelId}`. Unmapped or foreign-channel events are skipped visibly (`skipped` with a reason) and never imported. A Flite event mapped from two Cohost events is imported once.
- **Deferred caveat (T8).** As for the order-placed root, the Cohost `POST /orders` strips a client-supplied `paymentMethod`, so recording the imported orders as deferred on the Cohost side depends on T8; the converter output itself is deferred.
- **Known limits.** (a) The `importMaxPages` cap wastes empty-page calls for small events, and an event over the cap makes `import_complete` throw. (b) A channel with more than 100 events throws: `list-channel-events` is not paginated. (c) The nested binding `foreach.item.eventId` and body steps reading a sibling body step's output are assumed supported by the engine but were never run (no w6w writes or engine runs were allowed). (d) `get-channel-event-snapshot` is called without `listingId`; that is unverified.

## Behaviour (decisions D1–D7)

- **D1 Channel.** One company-owned, `api`, non-public channel with one primary listing. No new channel type.
- **D2 Account.** Flite sandbox credentials only, taken from the bound Flite connection. No new env vars. Staging host is `api-staging.fliteapi.city`.
- **D3 Removal / stop.** Unlist, hide, ended, canceled, draft: the Flite event is ended and its tickets set to unavailable. The Flite id mapping is kept. Re-adding the event reopens the same Flite event and tickets and never creates a second. An owner `started` event stays active (`hold`) only while its listing is present and `visibility === "visible"`.
- **D4 Remaining stock.** Flite ticket capacity is Cohost capacity − quantity sold − reserved. Cohost has no reservation count, so reserved is 0. `maximumQuantity` is never read. Sold counts come from Cohost; inbound Flite orders are imported by the third root (see Orders).
- **D5 Dedup.** Flite ids come only from the durable URN mappings (labels `id` / `eventId`), never from name matching. An event mapping suppresses `/create-event-partner`. With several event mappings the lexicographically smallest Flite id is used and a warning is emitted. A ticket mapping is honoured only if its `labels.eventId` equals the chosen event id. Mappings are registered right after creation. Lookup labels are `{provider, channelId}` (+ `kind`); `sync-event` then keeps only the mappings whose URN carries its own Flite connection id, so another Flite account or sandbox-vs-production never matches and never include `listingId`, which changes on remove→re-add. A differing stored `listingId` never causes a create; it re-registers the mapping with the new label.
- **D6 Multi-trigger.** Both roots normalize to (channel, event) and re-read current state; stale payload content is not used.
- **D7.** No change to the w6w engine and no Cohost API schema change.

Mapped URN: `urn:1:<companyId>:<fliteConnectionId>:/events/<fliteEventId>[/tickets/<fliteTicketId>]`.
Stored labels: `{provider:"flite", env, channelId, listingId, kind, id, eventId}`, where `env` is informational and comes from the connection.

## Mode table

Mode comes from the owner `event.status` and the snapshot:

| Condition | mode |
|---|---|
| status `live` and channel shows the event | `publish` |
| status `started`, listing present, `snapshot.visibility === "visible"` | `hold` |
| draft, ended, canceled, listing null, listing hidden, or `live` but not shown | `stop` |
| `stop` or `hold` with no event mapping | `noop` (zero requests) |

- `publish`: create (if unmapped) or update. Reads `/get-event-tickets-info` first. Sends `/update-event-properties` only for fields that differ. Reopens a remote ended event (`/update-event-end-toggle` ended=false). Uploads the flyer when Flite has none (`/update-event-flyer`, see Flyer). Remote tickets with no desired match get availability "false".
- `hold`: ticket capacity/availability updates only. No event update, end toggle or create.
- `stop`: end toggle ended=true unless already ended, and availability "false" on each remote ticket not already "false". No creates, no registrations, no `/delete-*` calls.
- An event-level conversion failure (no venue state/ZIP, no timezone) gives `event:null` plus an `errors` entry, and `sync-event` makes zero requests. Per-ticket problems (non-USD, donation) exclude that ticket and add an `errors` entry.
- The Flite environment is the connection's: a `-staging` auth key targets the sandbox API, anything else production. There is no env variable or `expectedEnv` field.
- `sync-event` does not throw after its first successful create: later failures go to `errors`.

## Flyer

The desired state carries `flyerUrl`: the channel's own flyer, else the owner event's (`flyer.url`), https only, else null.

- **On create** `sync-event` downloads it and uploads it as the multipart `hostFlyer` of `/create-event-partner` (PNG, JPEG, GIF or WebP, at most 10 MB). The download goes out **unsigned**: the Flite auth `sign` adds the token only on Flite's own API hosts, and strips any `authorization` header on other hosts. A flyer that cannot be downloaded or is not an image never blocks the create: the event is created without one and `warnings` says why.
- **Allowed hosts.** The app's `network.allow` adds `firebasestorage.googleapis.com` and `storage.googleapis.com`, where Cohost keeps flyers. A flyer on any other host is refused by the runtime and reported as a warning.
- **After create** (publish on a mapped event) `sync-event` fills a missing flyer: when Flite's `hostFlyer` is empty it downloads `flyerUrl` the same way and posts it to `/update-event-flyer` (multipart `eventId` + `hostFlyer`). That endpoint is not in Flite's partner reference; it was verified on the sandbox and production APIs on 2026-11-23. `/update-event-properties` ignores `hostFlyer` in every form. A download failure is a warning and a Flite refusal is an error; neither stops the rest of the sync. A flyer already on Flite is never replaced: Flite re-hosts uploads on its CDN, so a changed Cohost flyer cannot be detected.

## Descriptions

Flite gets plain text for the event and ticket descriptions. Flite renders a ticket description as text (HTML shows as literal tags), its app and search data read the event description as text, and the sandbox stores plain text verbatim (line breaks, `•`, `’`, `&`, `<`; checked 2026-11-23). The event page renders the description with `white-space: pre-wrap`, so paragraphs and bullet lines show; ticket descriptions collapse line breaks, so bullets run inline there.

- **Event.** Every live content block of the channel, else of the owner event, in `order`: the `description` block first and untitled, each other one as `Title` + newline + text; an FAQ block as its questions and answers. Without block text: the owner `description`, else `summary`, else the event name.
- **HTML → text.** Blocks are paragraphs, `<br>` a line break, list items `• ` lines (`1. ` in an ordered list), and all HTML 4 named and numeric entities are decoded. Scripts, styles and comments are dropped, and empty `<p>&nbsp;</p>` paragraphs vanish. A value with no HTML tag is plain text and keeps its line breaks.
- **Limit.** Over 5000 characters (the Flite app's own input limit) the text is cut at a paragraph or word break and ends in `…`.
- **Updates.** `sync-event` compares the description with Flite's and updates it when it differs, so the first sync after a transformer upgrade rewrites earlier HTML descriptions as text.

## Capacity formula

Per desired ticket, joined to the owner ticket by id:

    capacity = max(0, owner.capacity − owner.quantitySold)     (reserved = 0)

The key is omitted when owner capacity is absent. Availability is "true" for a live ticket, and "false" if sold out, capacity is 0, or `channelEvent.salesEnabled === false`.

Flite's own `capacity` is the total, including tickets it already sold. On update `sync-event` sends `max(desired, remote.sold)`, with availability "false" when desired ≤ remote.sold. Flite never shrinks below what it has already sold.

## Residual first-publish race

The dedupe lookup and the mapping write are not atomic with the Flite create. Two concurrent first publishes of the same event (both see no mapping) can each call `/create-event-partner`, leaving a duplicate Flite event. The workflow does not lock across runs, and there is no durable create claim. Once a mapping is registered, later runs converge on the smallest Flite id and emit a warning. The orphan is not deleted (sync never deletes) and must be cleaned up by hand. A durable create claim is deferred to follow-ups.

## Install steps

Offline structural check (no network):

    node scripts/workflow.ts validate workflows/flite-sales-channel.workflow.json
    npm run test:workflow

Install, publish or check status (dry run by default; prints method and path only):

    node scripts/workflow.ts install workflows/flite-sales-channel.workflow.json \
      --w6w <url> --project <project> --token-file <path> \
      --var channelId=<id> \
      --connection <ref>=<connectionId>
    # add --apply to send; publish and status take the same flags

Notes:
- The token comes only from `--token-file`; `--token` is rejected. The script never reads `process.env`.
- The only variable is `channelId`. `companyId` is the account const; the Flite environment and account are whatever the bound Flite connection is (bind a sandbox connection to test against staging).
- Install/publish/status use the confirmed w6w root paths (`POST /workflows`, `POST /workflows/:id/publish`, `GET /workflows/:id[/subscriptions|/runs]`); verified live in T3.
- The app catalog must contain `vip.cohost.w6w` (with `get-channel-event-snapshot`, `register-urn-mappings`, and the `channel-changed` trigger), `vip.cohost.flite` and `vip.cohost.transformers.flite`.

## Install notes (T3 sandbox E2E)

- The three tenant apps (`vip.cohost.w6w`, `vip.cohost.flite`, `vip.cohost.transformers.flite`) were built and installed into `.tenant-apps/cohost` digest-only: the version folders that `index.json` named were reused, and no version or folder was added. `vip.cohost.w6w` was built with `COHOST_API_URL=https://integrations-flite-s2.cohost.foo/api/v1`. `index-diff.py` confirms that only the digest-family fields of those three entries changed.
- The w6w container (`devcontainer-api-1`) re-registered the folder at 19:14Z (`[tenant-apps] cohost: … vip.cohost.w6w bumped`). The `app.js` sha256 inside the container equals `execSha256` in `index.json`. The manifest carries actions `get-channel-event-snapshot` and `register-urn-mappings` and triggers `channel-event-changed` and `channel-ticket-changed`.
- Catalog caveat: tenant apps live in the `cohost` tenant tier. A default-tenant/system token sees `GET /apps` as 682 system apps and none of `vip.cohost.*`. Install, publish and run requests must therefore authenticate as the `cohost` tenant.
- Preflight: `http://localhost:5999/api/v1/health` and `https://integrations-flite-s2.cohost.foo/api/v1/health` both returned 200 `{"status":"healthy"}`.
- `artifacts/e2e/reinstall.sh` re-applies the slot-2 build and `restore.sh` restores the backup (sha256 checked).

## Sandbox setup findings (T3 S4, 2026-11-21)

Run with `node scripts/sandbox-e2e.ts setup --token-file <cohost-tenant token> --w6w https://api-s2.w6w.dev --cohost-cred-file <json {email,password}> --out <artifacts/e2e> --apply`. It is idempotent: connections and the channel are found by the `fsc-e2e-` display name/name prefix, so a re-run creates nothing new. It writes `setup.json` (ids only, no secrets).

- **Connections.** `POST /apps/<appId>/connections` with `{authKey, displayName, credential}` (`POST /connections` is a 404); `POST /connections/<id>/test` re-checks. The Flite SANDBOX connection uses auth key `partner-login-staging` and the credential `{email, password}` taken from `oss/flite/.env.local`; it only ever travels in that body. The organization the connection landed on is `ORG A`, (the former `org` variable was only a mapping label and is gone; the connection id scopes the account).
- **Cohost connection.** Auth key `api-token` with the slot-2 auth-emulator bearer as the token. Its `test` reads `/orders?limit=1`, which answers 403 for the emulator user (company routes answer 200), so the test reports "token rejected" while the connection is `connected` and usable. The emulator token also expires after about an hour; re-run setup against a fresh connection if runs begin to answer 401.
- **Channel.** `POST /company/sales-channels` needs `channel.filters` (`{tags:[], excludeContextId:[], includeContextId:[]}`); without it the API answers 500. Created as `type api`, `isPublic false`.
- **Trigger params are stored unresolved.** After a plain install, the subscription for `channel-changed` stored `channelId` as the literal object `{"$":"vars.channelId"}`, so the T2 trigger's channel filter (`typeof params.channelId === "string"`) is skipped. `setup` therefore installs `artifacts/e2e/workflow.installed.json`, the workflow with the `channelId` of the channel trigger (`channel-changed`) written as the literal channel id; the stored subscription then shows `channelId: <id>`. `workflow.ts install --var channelId=<id>` now does this substitution itself (`bindChannelTriggers`). The channel root is channel-scoped; the former company-wide `ticket-changed` root is gone. Slot-2 / sold-count movement is still not in any channel signal.
- **Subscriptions.** After publish there is one per trigger node, both `enabled: true`, `status: registered`, `lastError: null` (`registered` is the active state). `POST /workflows` on an existing id answers 201 and replaces the definition; a following publish reconciles the subscriptions (a stale subscription from an older trigger key is replaced, not duplicated).

## Sandbox findings (T3 E2E matrix, 2026-11-21)

Flite staging only (`partner-login-staging`, `api-staging.fliteapi.city`); the request log shows 0 `api-main` and 108 `api-staging` lines. Results are in `artifacts/e2e/matrix.json` (R1–R13): PASS for R1, R2, R4–R10, R12, R13; RECORDED for R3 and R11.

- **Trigger delivery is synthetic.** Slot-2 has no webhook dispatcher: the automation outbox drain is a skeleton whose routing is not wired, and no automation service runs on the slot. The harness posts a ping to `/triggers/webhooks/<subscription>` for each Cohost change. Runs, snapshots, sync and Flite writes are real; the real Cohost → W delivery path was not exercised.
- **R3 (residual, vendor behaviour).** Two concurrent first publishes created two Flite events (remote count 2, both runs succeeded). Flite has no idempotency key on create and the dedupe is not atomic (see "Residual first-publish race"). Recorded, not fixed.
- **R10 found a T2 defect**, fixed by T4: the owner ticket list omits sold-out and hidden tickets, so the snapshot had no mapping for them and sync created a duplicate Flite ticket. After the fix (owner tickets read with `status=all`, mappings for the union of owner and channel ids) R10 passes: add, hide, sold-out and remove each update the same Flite ticket.
- **R11 (RECORDED).** Capacity 50 → 40 → 5 maps to Flite capacity 40 and 5 with only `update-ticket` ops. The partial-sale half (sold > 0) cannot be driven on slot-2 (no route creates a sale); `capacity - sold` is covered only by the T1 unit tests.
- **R12.** No second company can be created on slot-2, so the "foreign" event is an id the connection's company cannot read (API 404). The run fails at the snapshot node, no sync output, and the Flite event count is unchanged.
- **R13.** A EUR ticket and a donation ticket (`priceCategory donation`) fail the run with one error each; no Flite ticket exists for them and a second ping creates nothing.
- **Unlist route** is `DELETE /events/:id/channels/:channelId`. Flite stores the description as sent (then `<p>…</p>`; since transformer 2.2.0 plain text, see "Descriptions"). An empty description is recorded in R7.
- **Installed workflow** carries the channel trigger's `channelId` as a literal (trigger params are stored unresolved); see the setup findings above.
- **Tenant-app catalog.** Rows R1–R9 and R11–R13 ran on the first slot-2 build of `vip.cohost.w6w`; R10 ran on a rebuild from clean `cohost-w6w` HEAD including the T4 fix (a build from the lane's uncommitted overlay was rejected by the server with `manifest_mismatch`). The catalog is restored from backup at the end of the run.
