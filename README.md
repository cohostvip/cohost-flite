# Cohost / Flite W6W app pack

Two W6W apps and one shared types package:

| Package | W6W app ID | Responsibility |
| --- | --- | --- |
| [`packages/cohost-flite-transformer`](packages/cohost-flite-transformer/README.md) | `vip.cohost.transformers.flite` | Offline Flite ⇄ Cohost conversion of events, ticket types and orders. No authentication or network access. |
| [`packages/flite`](packages/flite/README.md) | `vip.cohost.flite` | Flite API calls, self-renewing partner sessions (production/staging), and the order-placed trigger. |
| [`packages/flite-types`](packages/flite-types/README.md) | (not an app) | `@cohost/flite-types`: Flite API types derived from real response JSON. Type-only; both apps use it. |

`w6w-pack.json` lists the two apps. Each bundles independently; the types package is erased at
build time, so neither app has a dependency. This repo has its own npm workspaces and must stay
outside the parent Cohost pnpm workspace.

## Develop and package

Node 22.18+ and npm only, run from this directory. TypeScript runs directly through Node's type
stripping; `tsc` only checks types.

```sh
npm ci
npm test              # unit tests (node --test)
npm run test:live     # local only: live Flite sessions and read-only endpoints, keys from .env.local
npm run check         # tsc --noEmit
npm run build         # bundle both apps into the release pack
npm run test:bundle   # build, then validate and run the built apps
npm run deploy:local  # check, build, then copy both apps into the local W6W tenant-apps folder
npm run types         # re-derive packages/flite-types/responses.ts from the JSON fixtures
npm run vendor:w6w    # refresh vendor/w6w/validator from the pinned w6w-core commit
```

`npm run build` creates a release pack in `FLITE_BUILD_DIR` (set it in `.env.local`, absolute or
relative to this directory; default `dist/`). The build replaces that folder only if it is empty or
holds a previous pack. The pack has `w6w-pack.json` and
`packages/{flite,cohost-flite-transformer}/`. Each built app contains its own `package.json`,
`app.js`, icon, README and license, with no dependencies. It is the only build: the W6W CLI
compiles nothing, and the apps have no build of their own.

Install the built pack (`file:./oss/flite/dist`) or one built app folder, never a source folder:
a source folder's `w6w.entry` is TypeScript, and W6W rejects dependency declarations and
`node_modules` in runtime apps. None of these commands registers apps with a server or changes
Flite data; `deploy:local` only writes files into `DEPLOY_FOLDER`.

| `scripts/` | Run by | Does |
| --- | --- | --- |
| `build.mjs` | `npm run build`, and so `test:bundle` and `deploy:local` | Bundles each app's `w6w.entry` with esbuild and writes the release pack. |
| `build-dir.ts` | imported by `build.mjs`, `deploy-local.mjs`, `tests/bundle.test.ts` | Resolves the build folder (`FLITE_BUILD_DIR`), loads `.env.local`, refuses to replace a folder that is not a pack. |
| `deploy-local.mjs` | `npm run deploy:local` | Runs `w6w build app` on each built app and merges the results into `DEPLOY_FOLDER`. |
| `derive-types.mjs` | `npm run types`; `--check` from `packages/flite-types/tests` | Writes `packages/flite-types/responses.ts` from the JSON fixtures, or fails if it is stale. |
| `anonymize-fixtures.mjs` | by hand: `node scripts/anonymize-fixtures.mjs .local/samples/<run>` | Turns a local live capture into the committed fixtures in `tests/fixtures/live/`. |
| `vendor-w6w.mjs` | `npm run vendor:w6w` | Copies `@w6w/validator` from the pinned w6w-core commit into `vendor/`. |

`npm run deploy:local` builds both apps into a local W6W tenant-apps folder, the same way
cohost-w6w does. Set `DEPLOY_FOLDER` in `.env.local` to the same folder as cohost-w6w's
(`<w6w checkout>/.tenant-apps/cohost`). It runs the type check and bundle tests (which build the
pack into the build folder), then `w6w build app <built app> --out <temp>` for each app. The CLI
compiles nothing: it assembles the bundle named by the built `package.json` into
`<id>/<version>/{manifest.json,app.js}`, which the script copies into `DEPLOY_FOLDER`. Only these
two apps' entries in `index.json` are added or updated. The W6W CLI is `W6W_CLI` (a `w6w.js` run
with node) or `w6w` on PATH; pass it through as `npm run deploy:local -- --cli <path>`. The W6W
server registers the folder when it boots.

`@w6w/types` and `@w6w/validator` are dev-only dependencies: the bundles erase them
(`npm run test:bundle` asserts no `@w6w/` reference ships). `@w6w/types` is `0.2.0` from npm,
pinned exactly. `@w6w/validator` is on neither npm nor JSR yet, so it is vendored in
`vendor/w6w/validator/` from w6w-core commit `05a20b86bedffc406877817ca79b29173e9aceac`, the
`types-v0.2.0` tag, so it matches the installed types (`npm run vendor:w6w` refreshes it). Bump
the two together. Once the validator is published, swap its `file:` specifier for a registry
version and delete `vendor/` and `scripts/vendor-w6w.mjs`.

`@w6w/types` ships TypeScript source, not JavaScript. Two consequences:
- Node will not strip types under `node_modules`, and the validator imports values from
  `@w6w/types`, so `tests/bundle.test.ts` loads the validator through esbuild.
- tsc checks that source with this repo's options, and `0.2.0` has a constructor parameter
  property, so `tsconfig.json` omits `erasableSyntaxOnly`. Node's type stripping still rejects
  non-erasable syntax in this repo's sources when the tests and the build load them.

This repo is Node + npm only: no Deno config, lockfile or `jsr:`/`npm:` specifiers. The vendored
validator is written for Deno upstream but is plain TypeScript. The W6W sandbox runtime is
Deno-only and is not run here. Tests use anonymized live fixtures, synthetic records and mock HTTP.

## Local credentials

Root `.env.local` was copied from the original runtime app. It contains the existing
`FLITE_BEARER_TOKEN`, `FLITE_TEST_EVENT_ID`, and `FLITE_API_URL`, and the Flite sandbox account as
`FLITE_SANDBOX_UNAME`/`FLITE_SANDBOX_PWD`. The sandbox keys are read only by local probe scripts
under `.local/`; no committed code reads them. `.env.local` is Git-ignored, has permissions `0600`,
and is excluded from both release packages. W6W connections store their credentials independently.

On 2026-11-12, `POST /api/partner-login` succeeded using the user-provided
`FLITE_WEBSITE_UNAME` and `FLITE_WEBSITE_PWD` in `.env.local`. The new seven-day partner
token replaced `FLITE_BEARER_TOKEN`; `FLITE_API_URL` points to
`https://api-main.fliteapi.city/api`. Organizations, events, event details, ticket
details, order listing, and order details returned HTTP 200 using that token.
Live captures are under `.local/samples/2026-11-12T22-26-05-588Z/`, including two
ticket types, one completed order, and one derived attendee/ticket record.

On 2026-11-13, the partner session flow from Flite's authentication spec was verified live:
login, refresh, the 5-minute replay of a used refresh token, revoke, and the error codes. The
probe revoked its own sessions. Captures are under `.local/samples/auth-2026-11-13T19-44-27Z/`;
anonymized copies are in `tests/fixtures/live/`.
Eight events returned HTTP 404 with `No completed orders found`, which the client
normalizes to an empty page. No event, ticket, order, or webhook data was changed.

On 2026-11-20, every documented partner endpoint was called and captured
(`.local/samples/endpoints-2026-11-20T00-15-37-351Z/`). Writes ran on **staging** only: a throwaway
event and ticket were created, read, updated, ended, reopened and deleted, and one staging
ticket was validated and checked in. Production got read-only calls. The new actions were then run
end to end on staging through the partner-session sign hook, again deleting what they created.
Anonymized copies are the `staging-*` fixtures in `tests/fixtures/live/`. The same run showed that
`GET /api/get-webhook-url` answers `{ data: { webhookUrl } }`; the client had read a top-level
`webhookUrl`, so `register-webhook` could not see an existing consumer. That is fixed.

On 2026-11-21, Flite's sandbox account was used to create, change and delete events and ticket
types, and to read its orders, recording every request and response (`.local/samples/sandbox-*`).
The account signs in on both hosts, and **staging and production return the same data**: an event
created on staging reads back on production, and orders are identical. Staging is not an isolated
copy, so a "staging only" write is not a safe write. Behaviors learned, now reflected in the apps:

- Ticket types have no fee or delivery fields and no minimum per cart; `customFees`, `adminFee`,
  `serviceFee`, `deliveryFee` and `minCart` are ignored. Create also ignores `maxCart`, which
  defaults to 10 (capacity defaults to 2000, availability to `true`).
- Event status (`Approved`, `Pending`, `Deleted`) is read-only; sandbox events are approved at
  once. `showEvent` is writable through `update-event-properties`, and ending an event is only
  `update-event-end-toggle`, which leaves ticket availability unchanged. `state` and `zipCode` are
  updatable, although the reference says they are not.
- Unknown or ignored fields answer HTTP 200 `No changes detected`, and so does an empty update,
  where the reference says 400. Flite also stores a sub-cent price as sent and accepts a negative
  price on update. Inputs are therefore validated locally, before the call.
- An unknown event answers HTTP 400 (not authorized); an unknown or deleted ticket answers 404.
- A create without a flyer succeeds (`hostFlyer: []`), so the flyer is optional.
- A deleted event still reads back, with status `Deleted`; the transformer maps it to `archived`.

The supplied reference's success examples are available in
[`samples/documented`](samples/documented/README.md), including events, tickets,
orders, and derived attendee records. These are explicitly labeled documentation
examples, separate from live responses under `.local/samples/`.

`npm run test:live` (`tests/live/`) runs against the real Flite API with the keys in `.env.local`:
`FLITE_WEBSITE_UNAME`/`FLITE_WEBSITE_PWD`, `FLITE_API_URL`, `FLITE_TEST_EVENT_ID` and, if set,
`FLITE_BEARER_TOKEN`. It covers sign-in, refresh (rotation, the 5-minute replay, error codes),
revoke, organizations, and the read-only actions (`list-organizations`, `list-events`, `get-event`
with and without tickets, `get-ticket`, `list-orders`, `get-order`, `get-webhook`, and
`validate-ticket` on a made-up ticket, which checks nothing in). It also converts every live event and order it reads. It writes no Flite data,
revokes every session it starts, and never prints tokens. `npm test` and CI do not include it;
without credentials it skips itself.

## Workflow composition

- Flite → Cohost: API `get-event`, `list-orders`, `get-order` or `order-placed` → transformer
  `flite-to-cohost` (event with its ticket types, ticket type, or order) → separately
  authenticated Cohost import step. `transform-order` remains for existing order workflows.
- Cohost → Flite writes: resolve mapped Flite IDs → transformer `cohost-to-flite` → the API action
  named by `actionKey`, using the returned `params`.
- Cohost → Flite fields: transformer `cohost-to-flite-data` returns Flite's own event, ticket and
  order fields, for comparison, export, or the API app's `create-event`, `update-event` and `create-ticket` actions.
- Snapshots/mappings: API `get-event` → transformer `event-snapshot` or `list-mapping-objects`.

Cohost writes and persistent mappings remain separate workflow steps; W6W has no legacy
`agent.cohostRequest`, `agent.mapper`, or `agent.queue`. Existing production workflows and
connections are not changed by this migration.

## Provenance

Migrated from `flite@1.0.0` build 2 at `w6w/.tmp-transfer/flite`. The original source remains there.
API routes, reverse transformations and PNG icon come from that app and its supplied API
documentation. Customer response captures, internal correspondence, and Swagger HTML are excluded.
ISC license retained.
