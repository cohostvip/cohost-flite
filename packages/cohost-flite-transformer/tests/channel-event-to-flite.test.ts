import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDesiredState, type ChannelSnapshot } from "../lib/channel-sync.ts";
import action from "../actions/channel-event-to-flite.ts";

const URN = "urn:1:co:cohost-falcon:/events/ev1";
const opts = {};

function snap(over: Record<string, unknown> = {}): ChannelSnapshot {
  return {
    channelId: "ch1",
    eventId: "ev1",
    companyId: "co",
    eventUrn: URN,
    listing: { id: "primary" },
    visibility: "visible",
    shown: true,
    channelEvent: { name: "Channel Name", salesEnabled: true, contentBlocks: [] },
    channelTickets: [
      { id: "t1", name: "GA", status: "live", priceCategory: "paid", costs: { cost: "USD,2500" }, description: "d" },
    ],
    event: {
      id: "ev1",
      name: "Owner Name",
      summary: "Owner summary",
      description: { text: "Owner desc" },
      status: "live",
      tz: "America/New_York",
      start: "2027-04-10T02:00:00.000Z",
      end: "2027-04-10T05:00:00.000Z",
      location: { name: "Hall", address: { address_1: "1 Main", city: "NYC", region: "NY", postal_code: "10001" } },
    },
    tickets: [{ id: "t1", capacity: 100, quantitySold: 30, status: "live" }],
    mappings: { event: [], tickets: {} },
    ...over,
  } as unknown as ChannelSnapshot;
}
const mapped = { event: [{ mappedUrn: "m" }], tickets: { t1: [{ mappedUrn: "m2" }] } };
const mode = (over: Record<string, unknown>) => buildDesiredState(snap(over), opts).mode;
const ev = (status: string, extra: Record<string, unknown> = {}) => ({
  event: { ...snap().event, status },
  mappings: mapped,
  ...extra,
});

test("mode table: 8 rows", () => {
  assert.equal(mode({}), "publish");
  assert.equal(mode(ev("started", { shown: false, visibility: "visible" })), "hold");
  assert.equal(mode(ev("draft")), "stop");
  assert.equal(mode(ev("ended")), "stop");
  assert.equal(mode(ev("canceled")), "stop");
  assert.equal(mode(ev("started", { shown: false, visibility: "hidden" })), "stop");
  assert.equal(mode(ev("live", { shown: false })), "stop");
  assert.equal(mode(ev("live", { listing: null, shown: false, visibility: null })), "stop");
});

test("mode table: noop rows", () => {
  assert.equal(mode({ event: { ...snap().event, status: "draft" } }), "noop");
  assert.equal(mode({ event: { ...snap().event, status: "started" }, shown: false }), "noop");
});

test("publish event: name, description fallbacks, dates, venue", () => {
  const d = buildDesiredState(snap(), opts);
  assert.equal(d.event!.eventName, "Channel Name");
  assert.equal(d.event!.description, "<p>Owner desc</p>");
  assert.equal(d.event!.startDate, "2027-04-09");
  assert.equal(d.event!.startTime, "22:00");
  assert.equal(d.event!.state, "New York");
  assert.equal(d.event!.zipCode, "10001");
  assert.equal(d.event!.showEvent, "true");
  const block = { channelEvent: { name: "N", contentBlocks: [{ designation: "description", data: { content: { html: "<p>Blk</p>" } } }] } };
  assert.equal(buildDesiredState(snap(block), opts).event!.description, "<p>Blk</p>");
  const o = snap().event;
  assert.equal(buildDesiredState(snap({ event: { ...o, description: {} } }), opts).event!.description, "<p>Owner summary</p>");
  assert.equal(buildDesiredState(snap({ event: { ...o, description: {}, summary: "" } }), opts).event!.description, "<p>Channel Name</p>");
});

test("publish tickets: capacity formula, availability, salesEnabled, errors", () => {
  let d = buildDesiredState(snap(), opts);
  assert.deepEqual(d.tickets.map((t) => [t.ticketId, t.capacity, t.availability, t.fields.ticketPrice]), [["t1", 70, "true", 25]]);
  assert.equal(d.tickets[0].ticketUrn, `${URN}/tickets/t1`);
  d = buildDesiredState(snap({ tickets: [{ id: "t1", capacity: 30, quantitySold: 30, status: "live" }] }), opts);
  assert.deepEqual([d.tickets[0].capacity, d.tickets[0].availability], [0, "false"]);
  d = buildDesiredState(snap({ tickets: [{ id: "t1", capacity: 100, quantitySold: 130, status: "live" }] }), opts);
  assert.equal(d.tickets[0].capacity, 0);
  d = buildDesiredState(snap({ tickets: [{ id: "t1", status: "live" }] }), opts);
  assert.equal("capacity" in d.tickets[0], false);
  assert.equal(d.tickets[0].availability, "true");
  d = buildDesiredState(snap({ channelEvent: { name: "N", salesEnabled: false } }), opts);
  assert.equal(d.tickets[0].availability, "false");
  d = buildDesiredState(snap({ channelTickets: [
    { id: "t1", name: "A", status: "live", priceCategory: "paid", costs: { cost: "EUR,100" } },
    { id: "t2", name: "B", status: "live", priceCategory: "donation", costs: { cost: "USD,100" } },
    { id: "t3", name: "C", status: "live", priceCategory: "free", costs: { cost: "USD,0" }, maximumQuantity: 2 },
  ] }), opts);
  assert.deepEqual(d.tickets.map((t) => t.ticketId), ["t3"]);
  assert.equal(d.errors.length, 2);
  assert.equal("maxCart" in d.tickets[0].fields, false);
});

test("hold: mapped owner tickets, capacity/availability only", () => {
  const d = buildDesiredState(snap({ ...ev("started", { shown: false }), tickets: [
    { id: "t1", capacity: 10, quantitySold: 4, status: "live" },
    { id: "t9", capacity: 10, quantitySold: 4, status: "live" },
  ] }), opts);
  assert.equal(d.mode, "hold");
  assert.equal(d.event, null);
  assert.deepEqual(d.tickets.map((t) => [t.ticketId, t.capacity, t.availability, Object.keys(t.fields).length]), [["t1", 6, "true", 0]]);
});

test("event-level failures: event null plus error", () => {
  const o = snap().event as Record<string, any>;
  const noZip = { ...o, location: { name: "H", address: { region: "NY", city: "x" } } };
  let d = buildDesiredState(snap({ event: noZip }), opts);
  assert.equal(d.event, null);
  assert.equal(d.errors.length, 1);
  d = buildDesiredState(snap({ event: { ...o, tz: "" } }), opts);
  assert.equal(d.event, null);
  assert.match(d.errors[0].message, /time zone/);
  assert.equal(d.errors[0].ticketId, undefined);
});

test("labels, ids and action wrapper", () => {
  const out = action.execute({ snapshot: snap(), ...opts }) as { desired: ReturnType<typeof buildDesiredState> };
  assert.deepEqual(out.desired.labels, { provider: "flite", channelId: "ch1", listingId: "primary" });
  assert.equal(out.desired.eventUrn, URN);
});

test("ticket errors carry ticketId; sold-out owner status closes; maximumQuantity never read", () => {
  const trap = { id: "t3", name: "C", status: "live", priceCategory: "free", costs: { cost: "USD,0" } };
  Object.defineProperty(trap, "maximumQuantity", { get() { throw new Error("maximumQuantity read"); }, enumerable: true });
  const d = buildDesiredState(snap({ channelTickets: [
    { id: "t1", name: "A", status: "live", priceCategory: "paid", costs: { cost: "EUR,100" } },
    { id: "t2", name: "B", status: "live", priceCategory: "paid", costs: { cost: "USD,900" } },
    trap,
  ], tickets: [{ id: "t2", capacity: 50, quantitySold: 5, status: "sold-out" }] }), opts);
  assert.equal(d.errors.length, 1);
  assert.match(d.errors[0].message, /^ticket t1:/);
  assert.equal(d.errors[0].ticketId, "t1");
  assert.deepEqual(d.tickets.map((t) => [t.ticketId, t.availability, t.fields.ticketPrice]), [["t2", "false", 9], ["t3", "true", 0]]);
});

test("non-USD ticket is excluded even when event currency option is EUR", () => {
  const d = buildDesiredState(snap({ channelTickets: [
    { id: "t1", name: "A", status: "live", priceCategory: "paid", costs: { cost: "EUR,100" } },
    { id: "t2", name: "B", status: "live", priceCategory: "paid", costs: { cost: "USD,100" } },
  ] }), { ...opts, currency: "EUR" } as typeof opts);
  assert.deepEqual(d.tickets.map((t) => t.ticketId), ["t2"]);
  assert.equal(d.errors[0].ticketId, "t1");
});
