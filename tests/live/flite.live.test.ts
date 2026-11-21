// Live Flite tests: real partner sessions and read-only endpoints, using the keys in `.env.local`.
//
//   npm run test:live
//
// Local only. `npm test` and CI never run this file; without `.env.local` it skips itself.
// Uses FLITE_WEBSITE_UNAME / FLITE_WEBSITE_PWD (partner login), FLITE_API_URL (environment),
// FLITE_TEST_EVENT_ID (event to read) and, if set, FLITE_BEARER_TOKEN (pasted-token auth).
//
// Nothing here changes Flite data: no event, ticket or webhook writes. Every partner session this
// file starts is revoked at the end. Assertions never print token values.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { AuthDefinition, HookContext } from "@w6w/types";
import type { FliteEventSummary, FliteEventWithTickets, FliteOrderListItem } from "@cohost/flite-types";
import * as session from "../../packages/flite/auth/partner-session.ts";
import type { FlitePartnerCredential } from "../../packages/flite/auth/partner-session.ts";
import * as bearer from "../../packages/flite/auth/bearer-token.ts";
import { API_URL, FliteClient, STAGING_API_URL } from "../../packages/flite/lib/client.ts";
import getEvent from "../../packages/flite/actions/get-event.ts";
import listOrders from "../../packages/flite/actions/list-orders.ts";
import getOrder from "../../packages/flite/actions/get-order.ts";
import getWebhook from "../../packages/flite/actions/get-webhook.ts";
import listOrganizations from "../../packages/flite/actions/list-organizations.ts";
import listEvents from "../../packages/flite/actions/list-events.ts";
import getTicket from "../../packages/flite/actions/get-ticket.ts";
import validateTicket from "../../packages/flite/actions/validate-ticket.ts";
import {
  cohostEventToFlite,
  fliteEventToCohost,
  fliteOrderToCohost,
  fliteTicketToCohost,
} from "../../packages/cohost-flite-transformer/convert/index.ts";

const envFile = new URL("../../.env.local", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;
const email = env.FLITE_WEBSITE_UNAME?.trim();
const password = env.FLITE_WEBSITE_PWD;
const apiUrl = (env.FLITE_API_URL?.trim() || API_URL).replace(/\/$/, "");
const isStaging = apiUrl === STAGING_API_URL;
const skip = !email || !password
  ? "set FLITE_WEBSITE_UNAME and FLITE_WEBSITE_PWD in .env.local"
  : apiUrl !== API_URL && apiUrl !== STAGING_API_URL
  ? `FLITE_API_URL must be ${API_URL} or ${STAGING_API_URL}`
  : false;

const auth = isStaging ? session.staging : session.production;
const bearerAuth = isStaging ? bearer.staging : bearer.production;
const source = { companyId: "company_live_test", connectionId: "connection_live_test" };
const DAY = 86_400_000;

/** A host-like context: every request goes through the auth's own `sign` hook, as W6W does. */
function signedContext(authDef: AuthDefinition, credential: unknown): HookContext {
  const ctx: HookContext = {
    connection: {
      id: "live_test",
      app: "vip.cohost.flite",
      auth: authDef.key,
      owner: "live-test",
      state: "connected",
      createdAt: new Date().toISOString(),
    },
    log() {},
    fetch: async (input, init = {}) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const request = {
        url: String(input),
        method: init.method ?? "GET",
        headers,
        ...(typeof init.body === "string" ? { body: init.body } : {}),
      };
      const signed = await authDef.sign!({ request, credential }, ctx);
      return await fetch(signed.url, { method: signed.method, headers: signed.headers, body: signed.body as BodyInit | undefined });
    },
  };
  return ctx;
}

/** Unsigned host egress, as `exchange`, `refresh`, `revoke` and `test` receive. */
const hookContext: HookContext = { fetch, log() {} };

/** Same value, compared without printing either token on failure. */
function same(a: string, b: string, what: string) {
  assert.ok(a === b, `${what}: expected the same value`);
}
function differs(a: string, b: string, what: string) {
  assert.ok(a !== b, `${what}: expected a new value`);
}

describe("Flite live: partner sessions and read-only endpoints", { skip, concurrency: false }, () => {
  /** Latest credential of every session started here; all are revoked in `after`. */
  const sessions = new Map<string, FlitePartnerCredential>();
  let current: FlitePartnerCredential;

  async function connect(fields: Record<string, unknown> = {}): Promise<FlitePartnerCredential> {
    const credential = await auth.exchange!({ fields: { email, password, ...fields } }, hookContext) as FlitePartnerCredential;
    sessions.set(credential.refreshToken, credential);
    return credential;
  }
  async function refresh(credential: FlitePartnerCredential): Promise<FlitePartnerCredential> {
    const next = await auth.refresh!({ credential }, hookContext) as FlitePartnerCredential;
    sessions.delete(credential.refreshToken);
    sessions.set(next.refreshToken, next);
    return next;
  }

  before(async () => {
    current = await connect();
  });

  after(async () => {
    for (const credential of sessions.values()) {
      try {
        await auth.revoke!({ credential }, hookContext);
      } catch {
        // Best effort: a session that cannot be revoked lapses with its refresh token.
      }
    }
  });

  test("connect: one login, no password stored, refresh scheduled a day before expiry", () => {
    const now = Date.now();
    assert.equal(JSON.stringify(current).includes(password!), false, "password must not be stored");
    assert.ok(current.token.split(".").length === 3, "access token is a JWT");
    assert.ok(current.refreshToken.length >= 32, "refresh token is opaque and long");
    const tokenExpiry = Date.parse(current.tokenExpiresAt);
    assert.ok(Math.abs(tokenExpiry - (now + 7 * DAY)) < 60_000, "access token lasts 7 days");
    assert.equal(Date.parse(current.expiresAt), tokenExpiry - session.REFRESH_MARGIN_MS);
    assert.ok(Math.abs(Date.parse(current.refreshTokenExpiresAt) - (now + 30 * DAY)) < 60_000, "refresh token lasts 30 days");
    assert.match(current.organizationId, /^[a-f0-9]{24}$/);
    assert.ok(current.organizationName && current.email);
  });

  test("credential test and connection label", async () => {
    assert.deepEqual(await auth.test({ credential: current }, hookContext), { ok: true });
    const label = await auth.afterConnect!({ credential: current }, hookContext);
    assert.deepEqual(Object.keys(label), ["email", "organization"]);
    assert.equal(label.organization, current.organizationName);
  });

  test("refresh rotates both tokens, and the new access token works", async () => {
    const before = current;
    current = await refresh(current);
    differs(current.token, before.token, "access token");
    differs(current.refreshToken, before.refreshToken, "refresh token");
    assert.equal(current.organizationId, before.organizationId);
    assert.ok(Date.parse(current.expiresAt) >= Date.parse(before.expiresAt));
    assert.deepEqual(await auth.test({ credential: current }, hookContext), { ok: true });

    // Within 5 minutes, the used refresh token replays the same pair (concurrent refreshers agree).
    const replay = await auth.refresh!({ credential: before }, hookContext) as FlitePartnerCredential;
    same(replay.token, current.token, "replayed access token");
    same(replay.refreshToken, current.refreshToken, "replayed refresh token");
    assert.ok(Math.abs(Date.parse(replay.tokenExpiresAt) - Date.parse(current.tokenExpiresAt)) < 5_000, "replay keeps the same expiry");
  });

  test("a second refresh in a row rotates again", async () => {
    const before = current;
    current = await refresh(current);
    differs(current.refreshToken, before.refreshToken, "refresh token");
    assert.deepEqual(await auth.test({ credential: current }, hookContext), { ok: true });
  });

  test("refresh errors carry Flite's code", async () => {
    await assert.rejects(
      async () => await auth.refresh!({ credential: { ...current, refreshToken: "not-a-real-refresh-token" } }, hookContext),
      /invalid_refresh_token, HTTP 401/,
    );
    assert.deepEqual(
      await auth.test({ credential: { ...current, token: "not-a-jwt" } }, hookContext),
      { ok: false, message: "Flite organization list failed (HTTP 401)" },
    );
  });

  test("disconnect ends only that session", async () => {
    const other = await connect();
    await auth.revoke!({ credential: other }, hookContext);
    sessions.delete(other.refreshToken);
    await assert.rejects(async () => await auth.refresh!({ credential: other }, hookContext), /refresh_token_reused, HTTP 401/);
    await auth.revoke!({ credential: other }, hookContext); // already ended: still fine
    assert.deepEqual(await auth.test({ credential: current }, hookContext), { ok: true }, "the other session is unaffected");
  });

  test("organizations: naming the login's own organization does not switch", async () => {
    const orgs = await session.organizations(fetch, apiUrl, current.token);
    assert.ok(orgs.some((org) => org._id === current.organizationId));
    const byName = await connect({ organization: current.organizationName.toUpperCase() });
    assert.equal(byName.organizationId, current.organizationId);
  });

  test("organizations: switching to another organization", async (t) => {
    const orgs = await session.organizations(fetch, apiUrl, current.token);
    const other = orgs.find((org) => org._id !== current.organizationId);
    if (!other) return t.skip(`this account has ${orgs.length} organization; nothing to switch to`);
    const switched = await connect({ organization: other._id });
    assert.equal(switched.organizationId, other._id);
    assert.deepEqual(await auth.test({ credential: switched }, hookContext), { ok: true });
  });

  test("events: list, then read and convert each event of the first page", async () => {
    const client = new FliteClient(signedContext(auth, current));
    const page = await client.request("/get-events-all", { query: { page: 1, limit: 10 } });
    assert.ok(Array.isArray(page.data), "events page has data[]");
    const events = page.data as FliteEventSummary[];
    assert.ok(events.length > 0, "the account has events");
    for (const summary of events) {
      const cohost = fliteEventToCohost(source, summary);
      assert.equal(cohost.refId, summary._id);
      assert.ok(Date.parse(cohost.end) > Date.parse(cohost.start), `${summary._id}: end after start`);
      const back = cohostEventToFlite(cohost);
      for (const key of ["eventName", "startDate", "startTime", "endDate", "endTime", "venueName"] as const) {
        assert.equal(back[key], summary[key], `${summary._id}: ${key} round-trips`);
      }
    }
  });

  test("get-event (FLITE_TEST_EVENT_ID or the first event) and its ticket types", async () => {
    const ctx = signedContext(auth, current);
    let eventId = env.FLITE_TEST_EVENT_ID?.trim();
    if (!eventId) {
      const page = await new FliteClient(ctx).request("/get-events-all", { query: { page: 1, limit: 1 } });
      eventId = (page.data as FliteEventSummary[])[0]._id;
    }
    const event = (await getEvent.execute({ eventId }, ctx)).event as FliteEventWithTickets;
    assert.equal(event._id, eventId);
    assert.ok(Array.isArray(event.tickets));
    const cohost = fliteEventToCohost(source, event);
    assert.equal(cohost.capacity, event.tickets.reduce((sum, t) => sum + t.capacity, 0));
    event.tickets.forEach((ticket, sorting) => {
      const converted = fliteTicketToCohost(source, ticket, { eventId, sorting });
      assert.ok(converted.urn?.endsWith(`/events/${eventId}/tickets/${ticket._id}`));
    });
  });

  test("list-organizations, list-events (paged, filtered) and get-event without tickets", async () => {
    const ctx = signedContext(auth, current);
    const { organizations, count } = await listOrganizations.execute({}, ctx);
    assert.ok(count >= 1 && organizations.every((o) => typeof o._id === "string"));
    const page = await listEvents.execute({ page: 1, limit: 3, status: ["Approved"] }, ctx);
    assert.ok(page.count <= 3);
    assert.equal(page.pagination?.limit, 3);
    assert.ok(page.events.every((e) => e.status === "Approved"));
    if (!page.count) return;
    const { event } = await getEvent.execute({ eventId: page.events[0]._id, includeTickets: false }, ctx);
    assert.equal(event._id, page.events[0]._id);
    assert.equal("tickets" in event, false);
  });

  test("get-ticket reads one ticket type of an event", async (t) => {
    const ctx = signedContext(auth, current);
    const { events } = await listEvents.execute({ page: 1, limit: 10 }, ctx);
    for (const summary of events) {
      const event = (await getEvent.execute({ eventId: summary._id }, ctx)).event as FliteEventWithTickets;
      if (!event.tickets.length) continue;
      const { ticket } = await getTicket.execute({ eventId: event._id, ticketId: event.tickets[0]._id }, ctx);
      assert.equal(ticket._id, event.tickets[0]._id);
      assert.equal(typeof ticket.sold, "number");
      return;
    }
    t.skip("no event on the first page has tickets");
  });

  test("validate-ticket reports an unknown ticket as a verdict, not an error (no check-in)", async () => {
    const result = await validateTicket.execute({ scanLink: "https://flite.city/Tickets/NOTAREALTICKET/scan" }, signedContext(auth, current));
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, "TICKET_NOT_FOUND");
  });

  test("list-orders and get-order: find orders, read and convert them", async (t) => {
    const ctx = signedContext(auth, current);
    const page = await new FliteClient(ctx).request("/get-events-all", { query: { page: 1, limit: 20 } });
    let found: { eventId: string; orders: FliteOrderListItem[] } | undefined;
    for (const event of page.data as FliteEventSummary[]) {
      const result = await listOrders.execute({ eventId: event._id, page: 1, limit: 2 }, ctx);
      assert.equal(result.count, result.orders.length);
      assert.ok(result.count <= 2, "limit is honored");
      if (result.orders.length) {
        found = { eventId: event._id, orders: result.orders };
        break;
      }
    }
    if (!found) return t.skip("no event on the first page has completed orders");
    for (const listed of found.orders) {
      const fromList = fliteOrderToCohost(source, listed, { eventId: found.eventId });
      const { order } = await getOrder.execute({ orderId: listed._id }, ctx);
      assert.equal(order._id, listed._id);
      assert.equal(order.eventId, found.eventId);
      const fromDetail = fliteOrderToCohost(source, order);
      assert.deepEqual(fromDetail.costs, fromList.costs, `${listed._id}: list and detail agree on money`);
      assert.equal(fromDetail.items.length, order.tickets.length);
    }
  });

  test("get-webhook reads the organization's webhook URL", async () => {
    const { webhookUrl } = await getWebhook.execute({}, signedContext(auth, current));
    assert.ok(webhookUrl === null || /^https:\/\//.test(webhookUrl));
  });

  test("actions keep working with a refreshed session", async () => {
    current = await refresh(current);
    const { webhookUrl } = await getWebhook.execute({}, signedContext(auth, current));
    assert.ok(webhookUrl === null || typeof webhookUrl === "string");
  });

  test("pasted bearer token (FLITE_BEARER_TOKEN), if set", async (t) => {
    const token = env.FLITE_BEARER_TOKEN?.trim();
    if (!token) return t.skip("FLITE_BEARER_TOKEN is not set");
    const result = await bearerAuth.test({ credential: { token } }, hookContext);
    if (!result.ok) return t.skip(`FLITE_BEARER_TOKEN was rejected (${result.message}); it expires after 7 days`);
    const { webhookUrl } = await getWebhook.execute({}, signedContext(bearerAuth, { token }));
    assert.ok(webhookUrl === null || typeof webhookUrl === "string");
  });
});
