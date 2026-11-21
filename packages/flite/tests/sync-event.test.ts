import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseEventMapping,
  chooseTicketMapping,
  type DesiredState,
  guardEnv,
  mappedUrn,
  planMappings,
  registration,
  relabelRegistrations,
} from "../lib/sync.ts";
import syncEvent from "../actions/sync-event.ts";
import { STAGING_API_URL } from "../lib/client.ts";
import { context } from "../../../tests/fixtures.ts";

const labels = { provider: "flite", env: "sandbox", org: "org_1", channelId: "ch_1", listingId: "L2" };

function desired(over: Partial<DesiredState> = {}): DesiredState {
  return {
    mode: "publish",
    companyId: "co_1",
    channelId: "ch_1",
    listingId: "L2",
    eventId: "ev_1",
    eventUrn: "urn:1:co_1:cohost-falcon:/events/ev_1",
    labels,
    event: null,
    tickets: [{ ticketId: "t1", ticketUrn: "urn:1:co_1:cohost-falcon:/events/ev_1/tickets/t1", fields: {}, availability: "true" }],
    mappings: { event: [], tickets: {} },
    errors: [],
    ...over,
  };
}
const rec = (id: string, extra: Record<string, string> = {}) => ({ labels: { id, eventId: id, listingId: "L1", ...extra } });

test("env guard: sandbox iff staging; mismatch with expectedEnv or labels throws", () => {
  const staging = context([], true).ctx;
  const prod = context([], false).ctx;
  assert.equal(guardEnv(staging, "sandbox", desired()), "sandbox");
  assert.equal(guardEnv(prod, "production", desired({ labels: { ...labels, env: "production" } })), "production");
  assert.throws(() => guardEnv(staging, "production", desired()), /sandbox but the workflow expects production/);
  assert.throws(() => guardEnv(prod, "sandbox", desired()), /production/);
  assert.throws(() => guardEnv(staging, "sandbox", desired({ labels: { ...labels, env: "production" } })), /sandbox/);
  assert.throws(() => guardEnv(staging, "bogus", desired()), /expectedEnv/);
});

test("mapped URN format", () => {
  assert.equal(mappedUrn("co", "sandbox", "e1"), "urn:1:co:flite-sandbox:/events/e1");
  assert.equal(mappedUrn("co", "production", "e1", "t1"), "urn:1:co:flite-production:/events/e1/tickets/t1");
});

test("event dedupe: none ⇒ create, one ⇒ use, many ⇒ smallest id + warning; listingId never selects", () => {
  assert.equal(chooseEventMapping([]).id, undefined);
  assert.equal(chooseEventMapping(undefined).id, undefined);
  assert.deepEqual(chooseEventMapping([rec("b")]), { id: "b", storedListingId: "L1", warnings: [] });
  const many = chooseEventMapping([rec("c"), { labels: { id: "a", eventId: "a", listingId: "L2" } }, rec("b")]);
  assert.equal(many.id, "a");
  assert.equal(many.warnings.length, 1);
  assert.match(many.warnings[0], /smallest id a/);
  // a mapping without labels.id is ignored (ids come from labels only, not mappedUrn)
  assert.equal(chooseEventMapping([{ mappedUrn: "urn:1:co:flite-sandbox:/events/zzz" }]).id, undefined);
});

test("ticket mapping honoured only when labels.eventId matches the chosen event", () => {
  const records = [
    { labels: { id: "t_a", eventId: "OTHER", listingId: "L1" } },
    { labels: { id: "t_z", eventId: "e1", listingId: "L1" } },
    { labels: { id: "t_m", eventId: "e1", listingId: "L1" } },
  ];
  const c = chooseTicketMapping(records, "e1");
  assert.equal(c.id, "t_m");
  assert.equal(c.warnings.length, 1);
  assert.equal(chooseTicketMapping([records[0]], "e1").id, undefined);
});

test("planMappings: unmapped event ⇒ no ids; mapped event + unmapped ticket ⇒ ticket create", () => {
  const none = planMappings(desired());
  assert.equal(none.fliteEventId, undefined);
  assert.equal(none.tickets[0].fliteTicketId, undefined);
  const plan = planMappings(desired({ mappings: { event: [rec("e1")], tickets: { t1: [{ labels: { id: "x", eventId: "other" } }] } } }));
  assert.equal(plan.fliteEventId, "e1");
  assert.equal(plan.tickets[0].fliteTicketId, undefined);
});

test("registration carries mappedUrn and every label", () => {
  const d = desired();
  assert.deepEqual(registration(d, "sandbox", "e1"), {
    urn: d.eventUrn,
    mappedUrn: "urn:1:co_1:flite-sandbox:/events/e1",
    labels: { provider: "flite", env: "sandbox", org: "org_1", channelId: "ch_1", listingId: "L2", kind: "event", id: "e1", eventId: "e1" },
  });
  const t = registration(d, "sandbox", "e1", { ticketUrn: d.tickets[0].ticketUrn, fliteTicketId: "ft1" });
  assert.equal(t.urn, d.tickets[0].ticketUrn);
  assert.equal(t.mappedUrn, "urn:1:co_1:flite-sandbox:/events/e1/tickets/ft1");
  assert.deepEqual(t.labels, { ...t.labels, kind: "ticket", id: "ft1", eventId: "e1", listingId: "L2" });
});

test("relabel only when stored listingId differs from desired", () => {
  const same = desired({
    labels: { ...labels, listingId: "L1" },
    mappings: { event: [rec("e1")], tickets: { t1: [rec("ft1", { eventId: "e1" })] } },
  });
  assert.deepEqual(relabelRegistrations(same, "sandbox", planMappings(same)), []);
  const diff = desired({ mappings: { event: [rec("e1")], tickets: { t1: [rec("ft1", { eventId: "e1" })] } } });
  const out = relabelRegistrations(diff, "sandbox", planMappings(diff));
  assert.deepEqual(out.map((r) => r.mappedUrn), [
    "urn:1:co_1:flite-sandbox:/events/e1",
    "urn:1:co_1:flite-sandbox:/events/e1/tickets/ft1",
  ]);
  assert.ok(out.every((r) => r.labels.listingId === "L2"));
  assert.deepEqual(relabelRegistrations(desired(), "sandbox", planMappings(desired())), []);
});

// ---- execute ----
const evFields = {
  eventName: "Show", description: "D", venueName: "V", venueLocation: "1 Main St", city: "NYC", state: "NY",
  zipCode: "10001", startDate: "2026-12-01", endDate: "2026-12-01", startTime: "20:00", endTime: "23:00", showEvent: "true",
};
const tkt = (id: string, over: Record<string, unknown> = {}) => ({
  ticketId: id, ticketUrn: `urn:1:co_1:cohost-falcon:/events/ev_1/tickets/${id}`,
  fields: { ticketName: "GA", ticketPrice: 10, description: "" }, availability: "true" as const, capacity: 50, ...over,
});
const remoteTicket = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id, ticketName: "GA", ticketPrice: 10, capacity: 50, sold: 5, availability: "true", description: "", ...over,
});
const remoteEvent = (over: Record<string, unknown> = {}, tickets: unknown[] = [remoteTicket("ft1")]) => ({
  success: true, data: { _id: "fe1", ...evFields, showEvent: true, isEventEnd: false, tickets, ...over },
});
const mapped = (over: Partial<DesiredState> = {}) => desired({
  event: evFields, tickets: [tkt("t1")],
  mappings: { event: [rec("fe1", { listingId: "L2" })], tickets: { t1: [{ labels: { id: "ft1", eventId: "fe1", listingId: "L2" } }] } },
  ...over,
});
const paths = (requests: Array<{ url: string }>) => requests.map((r) => new URL(r.url).pathname.replace(/^\/api/, ""));
const body = (r: { init: RequestInit }) => JSON.parse(String(r.init.body));

test("env guard throws before any request", async () => {
  const { ctx, requests } = context([], true);
  await assert.rejects(syncEvent.execute({ desired: mapped(), expectedEnv: "production" }, ctx), /expects production/);
  assert.equal(requests.length, 0);
  assert.ok(requests.every((r) => r.url.startsWith(STAGING_API_URL)));
});

test("publish create path: event then unmapped tickets, registrations for each", async () => {
  const { ctx, requests } = context([
    { success: true, data: { _id: "fe9" } }, { success: true, data: { _id: "ft9" } },
  ], true);
  const out = await syncEvent.execute({ desired: desired({ event: evFields, tickets: [tkt("t1")] }), expectedEnv: "sandbox" }, ctx);
  assert.deepEqual(paths(requests).map((p) => p.split("/").pop()), ["create-event-partner", "create-new-ticket"]);
  assert.ok(requests.every((r) => r.url.startsWith(STAGING_API_URL)));
  assert.equal(out.eventId, "fe9");
  assert.deepEqual(out.registrations.map((r) => r.mappedUrn), [
    "urn:1:co_1:flite-sandbox:/events/fe9", "urn:1:co_1:flite-sandbox:/events/fe9/tickets/ft9",
  ]);
  assert.equal(out.registrations[1].labels.eventId, "fe9");
  assert.equal(body(requests[1]).eventId, "fe9");
});

test("never throws after the first create: ticket failure goes to errors", async () => {
  const { ctx } = context([{ success: true, data: { _id: "fe9" } }, Response.json({}, { status: 500 })], true);
  const out = await syncEvent.execute({ desired: desired({ event: evFields, tickets: [tkt("t1")] }), expectedEnv: "sandbox" }, ctx);
  assert.equal(out.registrations.length, 1);
  assert.equal(out.errors.length, 1);
});

test("event null ⇒ zero requests, errors reported", async () => {
  const { ctx, requests } = context([], true);
  const out = await syncEvent.execute({ desired: desired({ event: null, errors: [{ message: "no tz" }] }), expectedEnv: "sandbox" }, ctx);
  assert.equal(requests.length, 0);
  assert.deepEqual(out.errors, ["no tz"]);
});

test("publish on mapped event: read first, no create, nothing to do when equal", async () => {
  const { ctx, requests } = context([remoteEvent()], true);
  const out = await syncEvent.execute({ desired: mapped({ tickets: [tkt("t1", { capacity: 50 })] }), expectedEnv: "sandbox" }, ctx);
  assert.deepEqual(paths(requests), ["/get-event-tickets-info"]);
  assert.deepEqual(out.registrations, []);
  assert.equal(requests.some((r) => r.url.includes("get-events-all")), false);
});

test("publish diff: reopen first, only changed event fields, clamped capacity, unmatched remote ticket hidden", async () => {
  const { ctx, requests } = context([
    remoteEvent({ isEventEnd: true, eventName: "Old" }, [remoteTicket("ft1"), remoteTicket("ft2")]),
    { success: true }, { success: true, data: {} }, { success: true, data: {} }, { success: true, data: {} },
  ], true);
  const out = await syncEvent.execute({
    desired: mapped({ event: { ...evFields }, tickets: [tkt("t1", { capacity: 3, fields: { ticketName: "VIP", ticketPrice: 10, description: "" } })] }),
    expectedEnv: "sandbox",
  }, ctx);
  assert.deepEqual(paths(requests), [
    "/get-event-tickets-info", "/update-event-end-toggle", "/update-event-properties", "/update-ticket-properties", "/update-ticket-properties",
  ]);
  assert.equal(body(requests[1]).isEventEnd, false);
  assert.deepEqual(body(requests[2]), { eventId: "fe1", eventName: "Show" });
  // sold = 5 > desired 3: capacity clamped to 5, availability "false", name changed, price untouched
  assert.deepEqual(body(requests[3]), { eventId: "fe1", ticketId: "ft1", ticketName: "VIP", capacity: 5, availability: "false" });
  assert.deepEqual(body(requests[4]), { eventId: "fe1", ticketId: "ft2", availability: "false" });
  assert.equal(out.errors.length, 0);
  // stored listingId L2 equals desired: no relabel
  assert.deepEqual(out.registrations, []);
});

test("relabel: stored listingId differs ⇒ registrations, never a create", async () => {
  const d = mapped({ listingId: "L9", labels: { ...labels, listingId: "L9" } });
  const { ctx, requests } = context([remoteEvent()], true);
  const out = await syncEvent.execute({ desired: d, expectedEnv: "sandbox" }, ctx);
  assert.equal(paths(requests).some((p) => p.includes("create")), false);
  assert.equal(out.registrations.length, 2);
  assert.equal(out.registrations[0].labels.listingId, "L9");
});

test("hold: ticket capacity/availability only, no event update, toggle or create", async () => {
  const { ctx, requests } = context([
    remoteEvent({ isEventEnd: true, eventName: "Old" }, [remoteTicket("ft1", { ticketName: "x" }), remoteTicket("ft2")]),
    { success: true, data: {} },
  ], true);
  const d = mapped({
    mode: "hold",
    tickets: [tkt("t1", { capacity: 20, fields: {} }), tkt("t2", { fields: {} })],
  });
  await syncEvent.execute({ desired: d, expectedEnv: "sandbox" }, ctx);
  assert.deepEqual(paths(requests), ["/get-event-tickets-info", "/update-ticket-properties"]);
  assert.deepEqual(body(requests[1]), { eventId: "fe1", ticketId: "ft1", capacity: 20 });
});

test("stop: end toggle unless ended, tickets hidden unless already false, no deletes, no registrations", async () => {
  const { ctx, requests } = context([
    remoteEvent({}, [remoteTicket("ft1"), remoteTicket("ft2", { availability: "false" })]),
    { success: true }, { success: true, data: {} },
  ], true);
  const out = await syncEvent.execute({ desired: mapped({ mode: "stop", listingId: "L9", labels: { ...labels, listingId: "L9" } }), expectedEnv: "sandbox" }, ctx);
  assert.deepEqual(paths(requests), ["/get-event-tickets-info", "/update-event-end-toggle", "/update-ticket-properties"]);
  assert.equal(body(requests[1]).isEventEnd, true);
  assert.equal(body(requests[2]).availability, "false");
  assert.equal(out.registrations.length, 0);
  assert.equal(paths(requests).some((p) => p.includes("delete")), false);

  const ended = context([remoteEvent({ isEventEnd: true }, [remoteTicket("ft1", { availability: "false" })])], true);
  await syncEvent.execute({ desired: mapped({ mode: "stop" }), expectedEnv: "sandbox" }, ended.ctx);
  assert.deepEqual(paths(ended.requests), ["/get-event-tickets-info"]);
});

test("noop: zero requests", async () => {
  const { ctx, requests } = context([], true);
  const out = await syncEvent.execute({ desired: desired({ mode: "noop" }), expectedEnv: "sandbox" }, ctx);
  assert.equal(requests.length, 0);
  assert.equal(out.mode, "noop");
});

test("publish with an unmapped ticket on a mapped event creates exactly one ticket", async () => {
  const { ctx, requests } = context([remoteEvent({}, []), { success: true, data: { _id: "ft7" } }], true);
  const d = mapped({ tickets: [tkt("t2")], mappings: { event: [rec("fe1", { listingId: "L2" })], tickets: {} } });
  const out = await syncEvent.execute({ desired: d, expectedEnv: "sandbox" }, ctx);
  assert.deepEqual(paths(requests), ["/get-event-tickets-info", "/create-new-ticket"]);
  assert.equal(out.registrations.some((r) => r.labels.id === "ft7"), true);
});

// ---- S6 audit: mutation-pinning execute-level tests ----
test("env guard, both directions + labels.env mismatch + non-staging ctx: zero requests", async () => {
  // staging ctx, expectedEnv production
  const a = context([], true);
  await assert.rejects(syncEvent.execute({ desired: mapped(), expectedEnv: "production" }, a.ctx), /expects production/);
  assert.equal(a.requests.length, 0);
  // non-staging ctx, expectedEnv sandbox
  const b = context([], false);
  await assert.rejects(syncEvent.execute({ desired: mapped(), expectedEnv: "sandbox" }, b.ctx));
  assert.equal(b.requests.length, 0);
  // labels.env disagrees with the connection
  const c = context([], true);
  await assert.rejects(syncEvent.execute({ desired: mapped({ labels: { ...labels, env: "production" } }), expectedEnv: "sandbox" }, c.ctx));
  assert.equal(c.requests.length, 0);
  // non-staging ctx, production desired + expected: passes the guard (noop ⇒ still zero requests)
  const d = context([], false);
  const out = await syncEvent.execute({ desired: desired({ mode: "noop", labels: { ...labels, env: "production" } }), expectedEnv: "production" }, d.ctx);
  assert.equal(out.env, "production");
  assert.equal(d.requests.length, 0);
});

test("two event mappings [fl_b, fl_a] ⇒ fl_a used, zero creates, warning", async () => {
  const { ctx, requests } = context([{ success: true, data: { _id: "fl_a", ...evFields, showEvent: true, isEventEnd: false, tickets: [] } }], true);
  const d = mapped({ tickets: [], mappings: { event: [rec("fl_b", { listingId: "L2" }), rec("fl_a", { listingId: "L2" })], tickets: {} } });
  const out = await syncEvent.execute({ desired: d, expectedEnv: "sandbox" }, ctx);
  assert.equal(out.eventId, "fl_a");
  assert.ok(requests[0].url.includes("fl_a"));
  assert.equal(paths(requests).some((p) => p.includes("create")), false);
  assert.ok(out.warnings.length >= 1);
  assert.ok(requests.every((r) => r.url.startsWith(STAGING_API_URL)));
});

test("capacity values on the wire: 70 stays 70; clamp 8; absent capacity sends no capacity key", async () => {
  const a = context([remoteEvent({}, [remoteTicket("ft1", { capacity: 100, sold: 20 })]), { success: true, data: {} }], true);
  await syncEvent.execute({ desired: mapped({ tickets: [tkt("t1", { capacity: 70 })] }), expectedEnv: "sandbox" }, a.ctx);
  assert.equal(body(a.requests[1]).capacity, 70);
  assert.equal(body(a.requests[1]).availability, undefined);

  const b = context([remoteEvent({}, [remoteTicket("ft1", { capacity: 50, sold: 8 })]), { success: true, data: {} }], true);
  await syncEvent.execute({ desired: mapped({ tickets: [tkt("t1", { capacity: 5 })] }), expectedEnv: "sandbox" }, b.ctx);
  assert.equal(body(b.requests[1]).capacity, 8);
  assert.equal(body(b.requests[1]).availability, "false");

  const c = context([remoteEvent({}, [remoteTicket("ft1", { capacity: 50, sold: 8, availability: "false" })]), { success: true, data: {} }], true);
  await syncEvent.execute({ desired: mapped({ tickets: [tkt("t1", { capacity: undefined })] }), expectedEnv: "sandbox" }, c.ctx);
  assert.equal(c.requests.length, 2);
  assert.equal("capacity" in body(c.requests[1]), false);
});

test("hold bodies carry no price/name; reopen precedes first update in publish", async () => {
  const h = context([remoteEvent({}, [remoteTicket("ft1", { ticketName: "x", ticketPrice: 99 })]), { success: true, data: {} }], true);
  await syncEvent.execute({ desired: mapped({ mode: "hold", tickets: [tkt("t1", { capacity: 30, fields: {} })] }), expectedEnv: "sandbox" }, h.ctx);
  const hb = body(h.requests[1]);
  assert.equal("ticketPrice" in hb, false);
  assert.equal("ticketName" in hb, false);

  const p = context([remoteEvent({ isEventEnd: true, eventName: "Old" }), { success: true }, { success: true }], true);
  await syncEvent.execute({ desired: mapped(), expectedEnv: "sandbox" }, p.ctx);
  assert.equal(paths(p.requests)[1], "/update-event-end-toggle");
  assert.equal(paths(p.requests)[2], "/update-event-properties");
});

test("ticket create 500 after event create resolves with 1 error and the event registration", async () => {
  const { ctx } = context([{ success: true, data: { _id: "fe9" } }, Response.json({}, { status: 500 })], true);
  const out = await syncEvent.execute({ desired: desired({ event: evFields, tickets: [tkt("t1")] }), expectedEnv: "sandbox" }, ctx);
  assert.equal(out.errors.length, 1);
  assert.deepEqual(out.registrations.map((r) => r.mappedUrn), ["urn:1:co_1:flite-sandbox:/events/fe9"]);
  const l = out.registrations[0].labels;
  for (const k of ["provider", "env", "org", "channelId", "listingId", "id", "eventId"]) assert.ok((l as Record<string, unknown>)[k], k);
});

test("stop with no remote tickets/already-false never writes tickets; no delete path anywhere", async () => {
  const { ctx, requests } = context([remoteEvent({}, []), { success: true }], true);
  const out = await syncEvent.execute({ desired: mapped({ mode: "stop" }), expectedEnv: "sandbox" }, ctx);
  assert.deepEqual(paths(requests), ["/get-event-tickets-info", "/update-event-end-toggle"]);
  assert.equal(out.registrations.length, 0);
  assert.ok(requests.every((r) => !r.url.includes("/delete-")));
});
