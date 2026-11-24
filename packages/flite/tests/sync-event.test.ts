import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseEventMapping,
  chooseTicketMapping,
  type DesiredState,
  connectionSegment,
  connectionEnv,
  scopeMappings,
  mappedUrn,
  planMappings,
  registration,
  relabelRegistrations,
} from "../lib/sync.ts";
import syncEvent from "../actions/sync-event.ts";
import { STAGING_API_URL } from "../lib/client.ts";
import { context } from "../../../tests/fixtures.ts";

const labels = { provider: "flite", channelId: "ch_1", listingId: "L2" };

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
/** A mapping record this connection (`w6w_connection`) registered: event, or ticket when `extra.eventId` names another event. */
const rec = (id: string, extra: Record<string, string> = {}, connection = "w6w_connection") => {
  const ev = extra.eventId ?? id;
  const mappedUrn = `urn:1:co_1:${connection}:/events/${ev}${ev === id ? "" : `/tickets/${id}`}`;
  return { mappedUrn, labels: { id, eventId: id, listingId: "L1", ...extra } };
};

test("environment comes from the connection: sandbox iff staging auth", () => {
  assert.equal(connectionEnv(context([], true).ctx), "sandbox");
  assert.equal(connectionEnv(context([], false).ctx), "production");
});

test("scopeMappings keeps only this connection's records under this company", () => {
  const own = rec("e1");
  const foreign = rec("e2", {}, "other_connection");
  const otherCo = { ...rec("e3"), mappedUrn: "urn:1:co_2:w6w_connection:/events/e3" };
  const ticket = rec("t9", { eventId: "e1" });
  const out = scopeMappings({ event: [own, foreign, otherCo, { labels: { id: "x" } } as never], tickets: { t1: [ticket, rec("t8", { eventId: "e2" }, "other_connection")] } }, "co_1", "w6w_connection");
  assert.deepEqual(out.event, [own]);
  assert.deepEqual(out.tickets.t1, [ticket]);
  assert.deepEqual(scopeMappings(undefined, "co_1", "c"), { event: [], tickets: {} });
});

test("mapped URN format", () => {
  assert.equal(mappedUrn("co", "conn_1", "e1"), "urn:1:co:conn_1:/events/e1");
  assert.equal(mappedUrn("co", "conn_1", "e1", "t1"), "urn:1:co:conn_1:/events/e1/tickets/t1");
});

test("event dedupe: none ⇒ create, one ⇒ use, many ⇒ smallest id + warning; listingId never selects", () => {
  assert.equal(chooseEventMapping([]).id, undefined);
  assert.equal(chooseEventMapping(undefined).id, undefined);
  assert.deepEqual(chooseEventMapping([rec("b")]), { id: "b", storedListingId: "L1", storedDigest: undefined, warnings: [] });
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
  assert.deepEqual(registration(d, "sandbox", "w6w_connection", "e1"), {
    urn: d.eventUrn,
    mappedUrn: "urn:1:co_1:w6w_connection:/events/e1",
    labels: { provider: "flite", env: "sandbox", channelId: "ch_1", listingId: "L2", kind: "event", id: "e1", eventId: "e1" },
  });
  const t = registration(d, "sandbox", "w6w_connection", "e1", { ticketUrn: d.tickets[0].ticketUrn, fliteTicketId: "ft1" });
  assert.equal(t.urn, d.tickets[0].ticketUrn);
  assert.equal(t.mappedUrn, "urn:1:co_1:w6w_connection:/events/e1/tickets/ft1");
  assert.deepEqual(t.labels, { ...t.labels, kind: "ticket", id: "ft1", eventId: "e1", listingId: "L2" });
});

test("relabel only when stored listingId differs from desired", () => {
  const same = desired({
    labels: { ...labels, listingId: "L1" },
    mappings: { event: [rec("e1")], tickets: { t1: [rec("ft1", { eventId: "e1" })] } },
  });
  assert.deepEqual(relabelRegistrations(same, "sandbox", "w6w_connection", planMappings(same)), []);
  const diff = desired({ mappings: { event: [rec("e1")], tickets: { t1: [rec("ft1", { eventId: "e1" })] } } });
  const out = relabelRegistrations(diff, "sandbox", "w6w_connection", planMappings(diff));
  assert.deepEqual(out.map((r) => r.mappedUrn), [
    "urn:1:co_1:w6w_connection:/events/e1",
    "urn:1:co_1:w6w_connection:/events/e1/tickets/ft1",
  ]);
  assert.ok(out.every((r) => r.labels.listingId === "L2"));
  assert.deepEqual(relabelRegistrations(desired(), "sandbox", "w6w_connection", planMappings(desired())), []);
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
  mappings: { event: [rec("fe1", { listingId: "L2" })], tickets: { t1: [rec("ft1", { eventId: "fe1", listingId: "L2" })] } },
  ...over,
});
const paths = (requests: Array<{ url: string }>) => requests.map((r) => new URL(r.url).pathname.replace(/^\/api/, ""));
const body = (r: { init: RequestInit }) => JSON.parse(String(r.init.body));

test("a mapping made under another Flite connection is ignored: the event is created on this one", async () => {
  const { ctx, requests } = context([{ success: true, data: { _id: "fe9" } }, { success: true, data: { _id: "ft9" } }], true);
  const d = desired({ event: evFields, tickets: [tkt("t1")], mappings: { event: [rec("fe1", { listingId: "L2" }, "other_connection")], tickets: {} } });
  const out = await syncEvent.execute({ desired: d }, ctx);
  assert.deepEqual(paths(requests).map((p) => p.split("/").pop()), ["create-event-partner", "create-new-ticket"]);
  assert.equal(out.eventId, "fe9");
  assert.equal(out.env, "sandbox");
  assert.ok(requests.every((r) => r.url.startsWith(STAGING_API_URL)));
});

test("publish create path: event then unmapped tickets, registrations for each", async () => {
  const { ctx, requests } = context([
    { success: true, data: { _id: "fe9" } }, { success: true, data: { _id: "ft9" } },
  ], true);
  const out = await syncEvent.execute({ desired: desired({ event: evFields, tickets: [tkt("t1")] }) }, ctx);
  assert.deepEqual(paths(requests).map((p) => p.split("/").pop()), ["create-event-partner", "create-new-ticket"]);
  assert.ok(requests.every((r) => r.url.startsWith(STAGING_API_URL)));
  assert.equal(out.eventId, "fe9");
  assert.deepEqual(out.registrations.map((r) => r.mappedUrn), [
    "urn:1:co_1:w6w_connection:/events/fe9", "urn:1:co_1:w6w_connection:/events/fe9/tickets/ft9",
  ]);
  assert.equal(out.registrations[1].labels.eventId, "fe9");
  assert.equal(body(requests[1]).eventId, "fe9");
});

test("never throws after the first create: ticket failure goes to errors", async () => {
  const { ctx } = context([{ success: true, data: { _id: "fe9" } }, Response.json({}, { status: 500 })], true);
  const out = await syncEvent.execute({ desired: desired({ event: evFields, tickets: [tkt("t1")] }) }, ctx);
  assert.equal(out.registrations.length, 1);
  assert.equal(out.errors.length, 1);
});

test("event null ⇒ zero requests, errors reported", async () => {
  const { ctx, requests } = context([], true);
  const out = await syncEvent.execute({ desired: desired({ event: null, errors: [{ message: "no tz" }] }) }, ctx);
  assert.equal(requests.length, 0);
  assert.deepEqual(out.errors, ["no tz"]);
});

test("mapped publish with event null ⇒ zero requests, errors from desired surfaced", async () => {
  const { ctx, requests } = context([], true);
  const out = await syncEvent.execute({ desired: mapped({ event: null, errors: [{ message: "no zip" }] }) }, ctx);
  assert.equal(requests.length, 0);
  assert.deepEqual(out.errors, ["no zip"]);
});

test("event mapping without labels.id ⇒ error, zero creates", async () => {
  const { ctx, requests } = context([], true);
  const d = desired({ event: evFields, mappings: { event: [{ mappedUrn: "urn:1:co_1:w6w_connection:/events/x", labels: { eventId: "x" } } as never], tickets: {} } });
  const out = await syncEvent.execute({ desired: d }, ctx);
  assert.equal(requests.length, 0);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /labels\.id/);
});

test("publish on mapped event: read first, no create, nothing to do when equal", async () => {
  const { ctx, requests } = context([remoteEvent()], true);
  const out = await syncEvent.execute({ desired: mapped({ tickets: [tkt("t1", { capacity: 50 })] }) }, ctx);
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
    desired: mapped({ event: { ...evFields }, tickets: [tkt("t1", { capacity: 3, fields: { ticketName: "VIP", ticketPrice: 10, description: "" } })] })
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
  const out = await syncEvent.execute({ desired: d }, ctx);
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
  await syncEvent.execute({ desired: d }, ctx);
  assert.deepEqual(paths(requests), ["/get-event-tickets-info", "/update-ticket-properties"]);
  assert.deepEqual(body(requests[1]), { eventId: "fe1", ticketId: "ft1", capacity: 20 });
});

test("stop: end toggle unless ended, tickets hidden unless already false, no deletes, no registrations", async () => {
  const { ctx, requests } = context([
    remoteEvent({}, [remoteTicket("ft1"), remoteTicket("ft2", { availability: "false" })]),
    { success: true }, { success: true, data: {} },
  ], true);
  const out = await syncEvent.execute({ desired: mapped({ mode: "stop", listingId: "L9", labels: { ...labels, listingId: "L9" } }) }, ctx);
  assert.deepEqual(paths(requests), ["/get-event-tickets-info", "/update-event-end-toggle", "/update-ticket-properties"]);
  assert.equal(body(requests[1]).isEventEnd, true);
  assert.equal(body(requests[2]).availability, "false");
  assert.equal(out.registrations.length, 0);
  assert.equal(paths(requests).some((p) => p.includes("delete")), false);

  const ended = context([remoteEvent({ isEventEnd: true }, [remoteTicket("ft1", { availability: "false" })])], true);
  await syncEvent.execute({ desired: mapped({ mode: "stop" }) }, ended.ctx);
  assert.deepEqual(paths(ended.requests), ["/get-event-tickets-info"]);
});

test("noop: zero requests", async () => {
  const { ctx, requests } = context([], true);
  const out = await syncEvent.execute({ desired: desired({ mode: "noop" }) }, ctx);
  assert.equal(requests.length, 0);
  assert.equal(out.mode, "noop");
});

test("publish with an unmapped ticket on a mapped event creates exactly one ticket", async () => {
  const { ctx, requests } = context([remoteEvent({}, []), { success: true, data: { _id: "ft7" } }], true);
  const d = mapped({ tickets: [tkt("t2")], mappings: { event: [rec("fe1", { listingId: "L2" })], tickets: {} } });
  const out = await syncEvent.execute({ desired: d }, ctx);
  assert.deepEqual(paths(requests), ["/get-event-tickets-info", "/create-new-ticket"]);
  assert.equal(out.registrations.some((r) => r.labels.id === "ft7"), true);
});

// ---- S6 audit: mutation-pinning execute-level tests ----
test("production connection: production env, production API, no expectedEnv needed", async () => {
  const d = context([], false);
  const out = await syncEvent.execute({ desired: desired({ mode: "noop" }) }, d.ctx);
  assert.equal(out.env, "production");
  assert.equal(d.requests.length, 0);
  assert.ok(!syncEvent.params.some((p) => p.key === "expectedEnv"), "no environment field to fill");
});

test("two event mappings [fl_b, fl_a] ⇒ fl_a used, zero creates, warning", async () => {
  const { ctx, requests } = context([{ success: true, data: { _id: "fl_a", ...evFields, showEvent: true, isEventEnd: false, tickets: [] } }], true);
  const d = mapped({ tickets: [], mappings: { event: [rec("fl_b", { listingId: "L2" }), rec("fl_a", { listingId: "L2" })], tickets: {} } });
  const out = await syncEvent.execute({ desired: d }, ctx);
  assert.equal(out.eventId, "fl_a");
  assert.ok(requests[0].url.includes("fl_a"));
  assert.equal(paths(requests).some((p) => p.includes("create")), false);
  assert.ok(out.warnings.length >= 1);
  assert.ok(requests.every((r) => r.url.startsWith(STAGING_API_URL)));
});

test("capacity values on the wire: 70 stays 70; clamp 8; absent capacity sends no capacity key", async () => {
  const a = context([remoteEvent({}, [remoteTicket("ft1", { capacity: 100, sold: 20 })]), { success: true, data: {} }], true);
  await syncEvent.execute({ desired: mapped({ tickets: [tkt("t1", { capacity: 70 })] }) }, a.ctx);
  assert.equal(body(a.requests[1]).capacity, 70);
  assert.equal(body(a.requests[1]).availability, undefined);

  const b = context([remoteEvent({}, [remoteTicket("ft1", { capacity: 50, sold: 8 })]), { success: true, data: {} }], true);
  await syncEvent.execute({ desired: mapped({ tickets: [tkt("t1", { capacity: 5 })] }) }, b.ctx);
  assert.equal(body(b.requests[1]).capacity, 8);
  assert.equal(body(b.requests[1]).availability, "false");

  const c = context([remoteEvent({}, [remoteTicket("ft1", { capacity: 50, sold: 8, availability: "false" })]), { success: true, data: {} }], true);
  await syncEvent.execute({ desired: mapped({ tickets: [tkt("t1", { capacity: undefined })] }) }, c.ctx);
  assert.equal(c.requests.length, 2);
  assert.equal("capacity" in body(c.requests[1]), false);
});

test("hold bodies carry no price/name; reopen precedes first update in publish", async () => {
  const h = context([remoteEvent({}, [remoteTicket("ft1", { ticketName: "x", ticketPrice: 99 })]), { success: true, data: {} }], true);
  await syncEvent.execute({ desired: mapped({ mode: "hold", tickets: [tkt("t1", { capacity: 30, fields: {} })] }) }, h.ctx);
  const hb = body(h.requests[1]);
  assert.equal("ticketPrice" in hb, false);
  assert.equal("ticketName" in hb, false);

  const p = context([remoteEvent({ isEventEnd: true, eventName: "Old" }), { success: true }, { success: true }], true);
  await syncEvent.execute({ desired: mapped() }, p.ctx);
  assert.equal(paths(p.requests)[1], "/update-event-end-toggle");
  assert.equal(paths(p.requests)[2], "/update-event-properties");
});

test("ticket create 500 after event create resolves with 1 error and the event registration", async () => {
  const { ctx } = context([{ success: true, data: { _id: "fe9" } }, Response.json({}, { status: 500 })], true);
  const out = await syncEvent.execute({ desired: desired({ event: evFields, tickets: [tkt("t1")] }) }, ctx);
  assert.equal(out.errors.length, 1);
  assert.deepEqual(out.registrations.map((r) => r.mappedUrn), ["urn:1:co_1:w6w_connection:/events/fe9"]);
  const l = out.registrations[0].labels;
  for (const k of ["provider", "env", "channelId", "listingId", "id", "eventId"]) assert.ok((l as Record<string, unknown>)[k], k);
});

test("stop with no remote tickets/already-false never writes tickets; no delete path anywhere", async () => {
  const { ctx, requests } = context([remoteEvent({}, []), { success: true }], true);
  const out = await syncEvent.execute({ desired: mapped({ mode: "stop" }) }, ctx);
  assert.deepEqual(paths(requests), ["/get-event-tickets-info", "/update-event-end-toggle"]);
  assert.equal(out.registrations.length, 0);
  assert.ok(requests.every((r) => !r.url.includes("/delete-")));
});

test("connectionSegment: ctx.connection.id, or a clear error", () => {
  assert.equal(connectionSegment(context([], true).ctx), "w6w_connection");
  assert.throws(() => connectionSegment({}), /connection id is required/);
  assert.throws(() => connectionSegment({ connection: { id: "a:b" } }), /valid URN segment/);
});

// ---- flyer ----
const FLYER = "https://firebasestorage.googleapis.com/v0/b/x/o/flyer.jpg?alt=media";
const jpeg = () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
const text = (r: { init: RequestInit }) => new TextDecoder().decode(r.init.body as Uint8Array);

test("create path uploads the desired flyer as hostFlyer: downloaded first, never with the Flite token", async () => {
  const { ctx, requests } = context([jpeg(), { success: true, data: { _id: "fe9" } }, { success: true, data: { _id: "ft9" } }], true);
  const out = await syncEvent.execute({ desired: desired({ event: evFields, tickets: [tkt("t1")], flyerUrl: FLYER }) }, ctx);
  assert.equal(requests[0].url, FLYER);
  assert.equal(new Headers(requests[0].init.headers).get("authorization"), null);
  assert.equal(new URL(requests[1].url).pathname, "/api/create-event-partner");
  const form = text(requests[1]);
  assert.match(form, /name="hostFlyer"; filename="flyer\.jpg"\r\nContent-Type: image\/jpeg/);
  assert.match(form, /name="eventName"/);
  assert.equal(out.eventId, "fe9");
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.errors, []);
});

test("a flyer that cannot be downloaded or is not an image never blocks the create: warning, no hostFlyer", async () => {
  for (const flyer of [new Response("nope", { status: 404 }), new Response("<html>", { headers: { "content-type": "text/html" } })]) {
    const { ctx, requests } = context([flyer, { success: true, data: { _id: "fe9" } }, { success: true, data: { _id: "ft9" } }], true);
    const out = await syncEvent.execute({ desired: desired({ event: evFields, tickets: [tkt("t1")], flyerUrl: FLYER }) }, ctx);
    assert.equal(out.eventId, "fe9");
    assert.doesNotMatch(text(requests[1]), /hostFlyer/);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /flyer/);
  }
});

test("mapped event without a Flite flyer: the flyer is uploaded with /update-event-flyer", async () => {
  const { ctx, requests } = context([remoteEvent({ hostFlyer: [] }), jpeg(), { success: true, data: { _id: "fe1", hostFlyer: ["https://cdn/x.jpg"] } }], true);
  const out = await syncEvent.execute({ desired: mapped({ flyerUrl: FLYER }) }, ctx);
  assert.deepEqual(paths(requests), ["/get-event-tickets-info", "/v0/b/x/o/flyer.jpg", "/update-event-flyer"]);
  assert.equal(new Headers(requests[1].init.headers).get("authorization"), null);
  const form = text(requests[2]);
  assert.match(form, /name="eventId"\r\n\r\nfe1\r\n/);
  assert.match(form, /name="hostFlyer"; filename="flyer\.jpg"\r\nContent-Type: image\/jpeg/);
  assert.deepEqual(out.operations.map((o) => [o.op, o.target]), [["update-event-flyer", "fe1"]]);
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.errors, []);
});

test("mapped event that already has a Flite flyer, or no desired flyer: no download, no flyer write", async () => {
  for (const [hostFlyer, flyerUrl] of [[["https://d3skqfvgyt6f3j.cloudfront.net/flyer/x.jpg"], FLYER], [[], null]] as const) {
    const { ctx, requests } = context([remoteEvent({ hostFlyer })], true);
    const out = await syncEvent.execute({ desired: mapped({ flyerUrl }) }, ctx);
    assert.deepEqual(paths(requests), ["/get-event-tickets-info"]);
    assert.deepEqual([out.warnings, out.errors], [[], []]);
  }
});

test("mapped event: a flyer that cannot be downloaded is a warning, and the rest of the sync still runs", async () => {
  const { ctx, requests } = context([remoteEvent({ hostFlyer: [], eventName: "old" }), new Response("nope", { status: 404 }), { success: true, data: {} }], true);
  const out = await syncEvent.execute({ desired: mapped({ flyerUrl: FLYER }) }, ctx);
  assert.deepEqual(paths(requests), ["/get-event-tickets-info", "/v0/b/x/o/flyer.jpg", "/update-event-properties"]);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /flyer not uploaded: HTTP 404/);
  assert.deepEqual(out.errors, []);
});

test("mapped event: Flite refusing the flyer is an error, and the rest of the sync still runs", async () => {
  const { ctx, requests } = context([remoteEvent({ hostFlyer: [], eventName: "old" }), jpeg(), new Response(JSON.stringify({ success: false, message: "bad" }), { status: 400 }), { success: true, data: {} }], true);
  const out = await syncEvent.execute({ desired: mapped({ flyerUrl: FLYER }) }, ctx);
  assert.deepEqual(paths(requests).slice(2), ["/update-event-flyer", "/update-event-properties"]);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /^update-event-flyer fe1: /);
});

// ---- content digest ----
const D1 = "v1:" + "a".repeat(64);
const D2 = "v1:" + "b".repeat(64);
/** A mapped desired state whose event mapping stores `stored` (on `connection`). */
const digested = (stored: string | undefined, over: Partial<DesiredState> = {}, connection = "w6w_connection") => mapped({
  digest: D1,
  mappings: {
    event: [rec("fe1", { listingId: "L2", ...(stored ? { digest: stored } : {}) }, connection)],
    tickets: { t1: [rec("ft1", { eventId: "fe1", listingId: "L2" })] },
  },
  ...over,
});
const eventRegs = (out: { registrations: Array<{ labels: Record<string, string> }> }) => out.registrations.filter((r) => r.labels.kind === "event");

test("skip: equal stored digest on this connection's mapping makes zero requests and returns unchanged", async () => {
  for (const mode of ["publish", "hold", "stop"] as const) {
    const { ctx, requests } = context([], true); // any fetch would throw
    const out = await syncEvent.execute({ desired: digested(D1, { mode }) }, ctx);
    assert.equal(requests.length, 0);
    assert.equal(out.unchanged, true);
    assert.deepEqual([out.operations, out.registrations, out.errors], [[], [], []]);
    assert.equal(out.eventId, "fe1");
  }
  assert.ok(syncEvent.output.some((o) => o.key === "unchanged"));
});

test("no skip: digest differs, is missing, is stored on another connection, or the run has errors / noop / unusable mapping", async () => {
  const cases: Array<[string, DesiredState]> = [
    ["differs", digested(D2)],
    ["not stored", digested(undefined)],
    ["desired has none", digested(D1, { digest: undefined })],
    ["other connection", digested(D1, {}, "other_connection")],
    ["desired errors", digested(D1, { errors: [{ message: "ticket x: bad", ticketId: "x" }] })],
  ];
  for (const [name, d] of cases) {
    const { ctx, requests } = context([remoteEvent()], true);
    const out = await syncEvent.execute({ desired: d }, ctx);
    assert.notEqual(out.unchanged, true, name);
    assert.ok(requests.length > 0 || name === "other connection", name);
  }
  const noop = context([], true);
  const n = await syncEvent.execute({ desired: digested(D1, { mode: "noop" }) }, noop.ctx);
  assert.notEqual(n.unchanged, true);
  const unusable = context([], true);
  const u = await syncEvent.execute({ desired: digested(D1, { mappings: { event: [{ mappedUrn: "urn:1:co_1:w6w_connection:/events/zz", labels: { digest: D1 } }], tickets: {} } }) }, unusable.ctx);
  assert.notEqual(u.unchanged, true);
  assert.match(u.errors[0], /no usable labels\.id/);
  assert.equal(unusable.requests.length, 0);
});

test("a digest stored on another connection's mapping does not skip: the event is created here", async () => {
  const { ctx, requests } = context([{ success: true, data: { _id: "fe9" } }, { success: true, data: { _id: "ft9" } }], true);
  const out = await syncEvent.execute({ desired: digested(D1, {}, "other_connection") }, ctx);
  assert.equal(out.eventId, "fe9");
  assert.equal(paths(requests)[0], "/create-event-partner");
});

test("digest saved after a successful publish; nothing saved when it already matches the stored one", async () => {
  const { ctx } = context([remoteEvent()], true);
  const out = await syncEvent.execute({ desired: digested(D2) }, ctx);
  assert.deepEqual(out.errors, []);
  assert.equal(out.registrations.length, 1);
  assert.equal(out.registrations[0].labels.kind, "event");
  assert.equal(out.registrations[0].labels.digest, D1);
  // no digest in the desired state (older transformer): never saved
  const old = context([remoteEvent()], true);
  assert.deepEqual((await syncEvent.execute({ desired: digested(D2, { digest: undefined }) }, old.ctx)).registrations, []);
});

test("digest saved in hold and stop modes too", async () => {
  const hold = context([remoteEvent()], true);
  const h = await syncEvent.execute({ desired: digested(undefined, { mode: "hold" }) }, hold.ctx);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(eventRegs(h).map((r) => r.labels.digest), [D1]);
  const stop = context([remoteEvent({ isEventEnd: true }, [remoteTicket("ft1", { availability: "false" })])], true);
  const s = await syncEvent.execute({ desired: digested(undefined, { mode: "stop", event: null, tickets: [] }) }, stop.ctx);
  assert.deepEqual(s.errors, []);
  assert.equal(s.registrations.length, 1);
  assert.equal(s.registrations[0].labels.digest, D1);
});

test("digest not saved when the run had an error", async () => {
  const failing = new Response(JSON.stringify({ success: false, message: "boom" }), { status: 500 });
  const { ctx } = context([remoteEvent({ eventName: "old" }), failing], true);
  const out = await syncEvent.execute({ desired: digested(undefined) }, ctx);
  assert.equal(out.errors.length, 1);
  assert.equal(out.registrations.some((r) => r.labels.digest !== undefined), false);
  // an error surfaced by the transformer (desired.errors) also blocks it
  const { ctx: c2 } = context([remoteEvent()], true);
  const e = await syncEvent.execute({ desired: digested(undefined, { errors: [{ message: "x" }] }) }, c2);
  assert.equal(e.registrations.some((r) => r.labels.digest !== undefined), false);
  // and a stop that failed
  const { ctx: c3 } = context([remoteEvent(), failing], true);
  const st = await syncEvent.execute({ desired: digested(undefined, { mode: "stop" }) }, c3);
  assert.ok(st.errors.length > 0);
  assert.deepEqual(st.registrations, []);
});

test("digest not saved when the flyer download failed; saved when the flyer worked", async () => {
  const bad = context([remoteEvent({ hostFlyer: [] }), new Response("nope", { status: 404 })], true);
  const b = await syncEvent.execute({ desired: digested(undefined, { flyerUrl: FLYER }) }, bad.ctx);
  assert.deepEqual(b.errors, []);
  assert.equal(b.warnings.length, 1);
  assert.equal(b.registrations.some((r) => r.labels.digest !== undefined), false);
  const good = context([remoteEvent({ hostFlyer: [] }), jpeg(), { success: true, data: {} }], true);
  const g = await syncEvent.execute({ desired: digested(undefined, { flyerUrl: FLYER }) }, good.ctx);
  assert.deepEqual(eventRegs(g).map((r) => r.labels.digest), [D1]);
});

test("a relabel and a digest change coincide: exactly one event registration, carrying the digest", async () => {
  const d = digested(D2, { listingId: "L9", labels: { ...labels, listingId: "L9" } });
  const { ctx } = context([remoteEvent()], true);
  const out = await syncEvent.execute({ desired: d }, ctx);
  assert.equal(eventRegs(out).length, 1);
  assert.equal(eventRegs(out)[0].labels.listingId, "L9");
  assert.equal(eventRegs(out)[0].labels.digest, D1);
  assert.equal(out.registrations.length, 2); // the event and the relabelled ticket
  assert.equal(out.registrations.find((r) => r.labels.kind === "ticket")!.labels.digest, undefined);
});

test("relabelRegistrations: digest alone emits the event registration; a relabel without digest carries none", () => {
  const d = digested(D2);
  const plan = planMappings(d);
  assert.equal(plan.storedDigest, D2);
  const only = relabelRegistrations(d, "sandbox", "w6w_connection", plan, D1);
  assert.equal(only.length, 1);
  assert.equal(only[0].labels.digest, D1);
  const relabel = desired({ mappings: { event: [rec("e1")], tickets: {} } });
  const r = relabelRegistrations(relabel, "sandbox", "w6w_connection", planMappings(relabel));
  assert.equal("digest" in r[0].labels, false);
  assert.equal("digest" in registration(d, "sandbox", "w6w_connection", "e1").labels, false);
});

test("create path: digest on the event registration only when every ticket and the flyer succeeded", async () => {
  const fresh = (over: Partial<DesiredState> = {}) => desired({ event: evFields, tickets: [tkt("t1")], digest: D1, ...over });
  const ok = context([{ success: true, data: { _id: "fe9" } }, { success: true, data: { _id: "ft9" } }], true);
  const a = await syncEvent.execute({ desired: fresh() }, ok.ctx);
  assert.deepEqual(a.registrations.map((r) => r.labels.kind), ["event", "ticket"]);
  assert.equal(a.registrations[0].labels.digest, D1);
  assert.equal(a.registrations[1].labels.digest, undefined);
  // ticket create fails
  const tf = context([{ success: true, data: { _id: "fe9" } }, new Response(JSON.stringify({ success: false }), { status: 500 })], true);
  const b = await syncEvent.execute({ desired: fresh() }, tf.ctx);
  assert.equal(b.errors.length, 1);
  assert.equal(b.registrations.length, 1);
  assert.equal(b.registrations[0].labels.digest, undefined);
  // flyer fails
  const ff = context([new Response("nope", { status: 404 }), { success: true, data: { _id: "fe9" } }, { success: true, data: { _id: "ft9" } }], true);
  const c = await syncEvent.execute({ desired: fresh({ flyerUrl: FLYER }) }, ff.ctx);
  assert.equal(c.registrations[0].labels.digest, undefined);
  // no digest in the desired state
  const nd = context([{ success: true, data: { _id: "fe9" } }, { success: true, data: { _id: "ft9" } }], true);
  const d = await syncEvent.execute({ desired: fresh({ digest: undefined }) }, nd.ctx);
  assert.equal(d.registrations[0].labels.digest, undefined);
});
