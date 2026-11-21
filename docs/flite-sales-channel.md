# Flite sales channel (internal)

A Cohost company-owned, non-public API channel mirrors its events onto Flite. A two-root w6w workflow
re-reads current Cohost truth on every trigger and reconciles Flite against it. It only ever creates,
updates, stops and reopens; it never deletes anything on Flite.

## Pipeline

`channel-event-changed` (channel actions listed / changed / unlisted) and `ticket-changed`
(created / updated / deleted) both feed one `@w6w/race` node, then:

1. `get-channel-event-snapshot` (app `vip.cohost.w6w`) — channel view, owner event + tickets, listing, RMS mappings.
2. `channel-event-to-flite` (`vip.cohost.transformers.flite`) — pure: snapshot → desired Flite state.
3. `sync-event` (`vip.cohost.flite`) — reconciles desired state against Flite and the mappings.
4. `register-urn-mappings` (retry 3) — persists `sync-event`'s `registrations`.
5. `report` (`@w6w/script`) — fails the run iff `sync-event` returned `errors`. It runs after step 4, so mappings are saved even when the run fails.

Workflow file: `workflows/flite-sales-channel.workflow.json`. It holds no ids, tokens or credentials; connections are refs bound at install.

## Behaviour (decisions D1–D7)

- **D1 Channel.** One company-owned, `api`, non-public channel with one primary listing. No new channel type.
- **D2 Account.** Flite sandbox credentials only, taken from the bound Flite connection. No new env vars. Staging host is `api-staging.fliteapi.city`.
- **D3 Removal / stop.** Unlist, hide, ended, canceled, draft: the Flite event is ended and its tickets set to unavailable. The Flite id mapping is kept. Re-adding the event reopens the same Flite event and tickets and never creates a second. An owner `started` event stays active (`hold`) only while its listing is present and `visibility === "visible"`.
- **D4 Remaining stock.** Flite ticket capacity is Cohost capacity − quantity sold − reserved. Cohost has no reservation count, so reserved is 0. `maximumQuantity` is never read. Inbound Flite orders are not tracked.
- **D5 Dedup.** Flite ids come only from the durable URN mappings (labels `id` / `eventId`), never from name matching. An event mapping suppresses `/create-event-partner`. With several event mappings the lexicographically smallest Flite id is used and a warning is emitted. A ticket mapping is honoured only if its `labels.eventId` equals the chosen event id. Mappings are registered right after creation. Lookup labels are `{provider, env, org, channelId}` (+ `kind`) and never include `listingId`, which changes on remove→re-add. A differing stored `listingId` never causes a create; it re-registers the mapping with the new label.
- **D6 Multi-trigger.** Both roots normalize to (channel, event) and re-read current state; stale payload content is not used.
- **D7.** No change to the w6w engine and no Cohost API schema change.

Mapped URN: `urn:1:<companyId>:flite-<env>:/events/<fliteEventId>[/tickets/<fliteTicketId>]`.
Stored labels: `{provider:"flite", env, org, channelId, listingId, kind, id, eventId}`.

## Mode table

Mode comes from the owner `event.status` and the snapshot:

| Condition | mode |
|---|---|
| status `live` and channel shows the event | `publish` |
| status `started`, listing present, `snapshot.visibility === "visible"` | `hold` |
| draft, ended, canceled, listing null, listing hidden, or `live` but not shown | `stop` |
| `stop` or `hold` with no event mapping | `noop` (zero requests) |

- `publish`: create (if unmapped) or update. Reads `/get-event-tickets-info` first. Sends `/update-event-properties` only for fields that differ. Reopens a remote ended event (`/update-event-end-toggle` ended=false). Remote tickets with no desired match get availability "false".
- `hold`: ticket capacity/availability updates only. No event update, end toggle or create.
- `stop`: end toggle ended=true unless already ended, and availability "false" on each remote ticket not already "false". No creates, no registrations, no `/delete-*` calls.
- An event-level conversion failure (no venue state/ZIP, no timezone) gives `event:null` plus an `errors` entry, and `sync-event` makes zero requests. Per-ticket problems (non-USD, donation) exclude that ticket and add an `errors` entry.
- The env guard throws before any request unless the client host matches `expectedEnv` (`sandbox` iff the base URL is the staging URL) and `desired.labels.env`.
- `sync-event` does not throw after its first successful create: later failures go to `errors`.

## Capacity formula

Per desired ticket, joined to the owner ticket by id:

    capacity = max(0, owner.capacity − owner.quantitySold)     (reserved = 0)

The key is omitted when owner capacity is absent. Availability is "true" for a live ticket, and "false" if sold out, capacity is 0, or `channelEvent.salesEnabled === false`.

Flite's own `capacity` is the total, including tickets it already sold. On update `sync-event` sends `max(desired, remote.sold)`, with availability "false" when desired ≤ remote.sold. Flite never shrinks below what it has already sold.

## Residual first-publish race

The dedupe lookup and the mapping write are not atomic with the Flite create. Two concurrent first publishes of the same event (both see no mapping) can each call `/create-event-partner`, leaving a duplicate Flite event. The `@w6w/race` node only merges the two trigger roots into one path; it does not lock across runs, and there is no durable create claim. Once a mapping is registered, later runs converge on the smallest Flite id and emit a warning. The orphan is not deleted (sync never deletes) and must be cleaned up by hand. A durable create claim is deferred to follow-ups.

## Install steps

Offline structural check (no network):

    node scripts/workflow.ts validate workflows/flite-sales-channel.workflow.json
    npm run test:workflow

Install, publish or check status (dry run by default; prints method and path only):

    node scripts/workflow.ts install workflows/flite-sales-channel.workflow.json \
      --w6w <url> --project <project> --token-file <path> \
      --var channelId=<id> --var env=sandbox --var org=<flite-org> \
      --connection <ref>=<connectionId>
    # add --apply to send; publish and status take the same flags

Notes:
- The token comes only from `--token-file`; `--token` is rejected. The script never reads `process.env`.
- Required variables: `channelId`, `env` (`sandbox|production`), `org`; `currency` defaults to `USD`.
- Bind the Flite connection to the sandbox account for `env=sandbox`. The env guard makes a mismatch fail before any request.
- The REST paths used by install/publish/status (`/projects/<p>/workflows[/<key>/publish]`) are unconfirmed placeholders. Confirm them against the real w6w API before using `--apply`.
- The app catalog must contain `vip.cohost.w6w` (with `get-channel-event-snapshot`, `register-urn-mappings`, and the two triggers), `vip.cohost.flite` and `vip.cohost.transformers.flite`.

## Install notes (T3 sandbox E2E)

- The three tenant apps (`vip.cohost.w6w`, `vip.cohost.flite`, `vip.cohost.transformers.flite`) were built and installed into `.tenant-apps/cohost` digest-only: the version folders that `index.json` named were reused, and no version or folder was added. `vip.cohost.w6w` was built with `COHOST_API_URL=https://integrations-flite-s2.cohost.foo/api/v1`. `index-diff.py` confirms that only the digest-family fields of those three entries changed.
- The w6w container (`devcontainer-api-1`) re-registered the folder at 19:14Z (`[tenant-apps] cohost: … vip.cohost.w6w bumped`). The `app.js` sha256 inside the container equals `execSha256` in `index.json`. The manifest carries actions `get-channel-event-snapshot` and `register-urn-mappings` and triggers `channel-event-changed` and `ticket-changed`.
- Catalog caveat: tenant apps live in the `cohost` tenant tier. A default-tenant/system token sees `GET /apps` as 682 system apps and none of `vip.cohost.*`. Install, publish and run requests must therefore authenticate as the `cohost` tenant.
- Preflight: `http://localhost:5999/api/v1/health` and `https://integrations-flite-s2.cohost.foo/api/v1/health` both returned 200 `{"status":"healthy"}`.
- `artifacts/e2e/reinstall.sh` re-applies the slot-2 build and `restore.sh` restores the backup (sha256 checked).

## Sandbox setup findings (T3 S4, 2026-11-21)

Run with `node scripts/sandbox-e2e.ts setup --token-file <cohost-tenant token> --w6w https://api-s2.w6w.dev --cohost-cred-file <json {email,password}> --out <artifacts/e2e> --apply`. It is idempotent: connections and the channel are found by the `fsc-e2e-` display name/name prefix, so a re-run creates nothing new. It writes `setup.json` (ids only, no secrets).

- **Connections.** `POST /apps/<appId>/connections` with `{authKey, displayName, credential}` (`POST /connections` is a 404); `POST /connections/<id>/test` re-checks. The Flite SANDBOX connection uses auth key `partner-login-staging` and the credential `{email, password}` taken from `oss/flite/.env.local`; it only ever travels in that body. The organization the connection landed on is `ORG A`, and that is what the workflow `org` variable carries (the variable is only a mapping label).
- **Cohost connection.** Auth key `api-token` with the slot-2 auth-emulator bearer as the token. Its `test` reads `/orders?limit=1`, which answers 403 for the emulator user (company routes answer 200), so the test reports "token rejected" while the connection is `connected` and usable. The emulator token also expires after about an hour; re-run setup against a fresh connection if runs begin to answer 401.
- **Channel.** `POST /company/sales-channels` needs `channel.filters` (`{tags:[], excludeContextId:[], includeContextId:[]}`); without it the API answers 500. Created as `type api`, `isPublic false`.
- **Trigger params are stored unresolved.** After a plain install, the subscription for `channel-event-changed` stored `channelId` as the literal object `{"$":"vars.channelId"}`, so the T2 trigger's channel filter (`typeof params.channelId === "string"`) is skipped. `setup` therefore installs `artifacts/e2e/workflow.installed.json`, the T1 workflow with that one trigger's `channelId` written as the literal channel id; the stored subscription then shows `channelId: <id>`. `workflow.ts install` could do this substitution itself (follow-up); `ticket-changed` has no channel param, and the snapshot step decides channel membership.
- **Subscriptions.** After publish there are exactly two, one per trigger node, both `enabled: true`, `status: registered`, `lastError: null` (`registered` is the active state). `POST /workflows` on an existing id answers 201 and replaces the definition; a following publish reconciles the subscriptions (the old `channel-event-changed` one is replaced, not duplicated).

## Sandbox findings (T3 E2E matrix, 2026-11-21)

Flite staging only (`partner-login-staging`, `api-staging.fliteapi.city`); the request log shows 0 `api-main` and 108 `api-staging` lines. Results are in `artifacts/e2e/matrix.json` (R1–R13): PASS for R1, R2, R4–R10, R12, R13; RECORDED for R3 and R11.

- **Trigger delivery is synthetic.** Slot-2 has no webhook dispatcher: the automation outbox drain is a skeleton whose routing is not wired, and no automation service runs on the slot. The harness posts a ping to `/triggers/webhooks/<subscription>` for each Cohost change. Runs, snapshots, sync and Flite writes are real; the real Cohost → W delivery path was not exercised.
- **R3 (residual, vendor behaviour).** Two concurrent first publishes created two Flite events (remote count 2, both runs succeeded). Flite has no idempotency key on create and the dedupe is not atomic (see "Residual first-publish race"). Recorded, not fixed.
- **R10 found a T2 defect**, fixed by T4: the owner ticket list omits sold-out and hidden tickets, so the snapshot had no mapping for them and sync created a duplicate Flite ticket. After the fix (owner tickets read with `status=all`, mappings for the union of owner and channel ids) R10 passes: add, hide, sold-out and remove each update the same Flite ticket.
- **R11 (RECORDED).** Capacity 50 → 40 → 5 maps to Flite capacity 40 and 5 with only `update-ticket` ops. The partial-sale half (sold > 0) cannot be driven on slot-2 (no route creates a sale); `capacity - sold` is covered only by the T1 unit tests.
- **R12.** No second company can be created on slot-2, so the "foreign" event is an id the connection's company cannot read (API 404). The run fails at the snapshot node, no sync output, and the Flite event count is unchanged.
- **R13.** A EUR ticket and a donation ticket (`priceCategory donation`) fail the run with one error each; no Flite ticket exists for them and a second ping creates nothing.
- **Unlist route** is `DELETE /events/:id/channels/:channelId`. Flite stores the description as `<p>…</p>`. An empty description is recorded in R7.
- **Installed workflow** carries the channel trigger's `channelId` as a literal (trigger params are stored unresolved); see the setup findings above.
- **Tenant-app catalog.** Rows R1–R9 and R11–R13 ran on the first slot-2 build of `vip.cohost.w6w`; R10 ran on a rebuild from clean `cohost-w6w` HEAD including the T4 fix (a build from the lane's uncommitted overlay was rejected by the server with `manifest_mismatch`). The catalog is restored from backup at the end of the run.
