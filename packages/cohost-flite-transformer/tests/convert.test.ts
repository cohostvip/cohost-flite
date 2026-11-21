import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type {
  FliteEvent,
  FliteEventSummary,
  FliteEventWithTickets,
  FliteOrder,
  FliteOrdersPage,
  FliteResponse,
  FliteTicket,
} from "@cohost/flite-types";
import { cohostEventToFlite, fliteEventToCohost } from "../convert/event.ts";
import { cohostTicketToFlite, fliteTicketToCohost } from "../convert/ticket.ts";
import { cohostOrderToFlite, fliteOrderToCohost } from "../convert/order.ts";
import { htmlToText, stateCode, stateName, utcToZoned, zonedToUtc } from "../convert/support.ts";
import fliteToCohostAction from "../actions/flite-to-cohost.ts";
import cohostToFliteDataAction from "../actions/cohost-to-flite-data.ts";
import { event, order, source } from "../../../tests/fixtures.ts";
import { readCapture } from "../../../tests/live-fixtures.ts";

const live = <T>(name: string) => readCapture<FliteResponse<T>>(name).body.data;
const documented = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../../../samples/documented/${name}.json`, import.meta.url), "utf8")).data;

const liveEvents = [
  ...live<FliteEventSummary[]>("events-page-1"),
  live<FliteEvent>("event-1"),
  live<FliteEventWithTickets>("event-1-with-tickets"),
];
const liveTickets = [live<FliteTicket>("event-1-ticket-1"), live<FliteTicket>("event-1-ticket-2")];
const detailOrders = [live<FliteOrder>("event-9-order-1"), documented<FliteOrder>("order")];
const listOrders = live<FliteOrdersPage>("event-9-orders-page-1").orders;

const EVENT_FIELDS = [
  "eventName", "venueName", "venueLocation", "city", "state", "startDate", "startTime", "endDate", "endTime",
] as const;

// ---- support

test("local Flite times convert to UTC and back, across DST and midnight", () => {
  assert.equal(zonedToUtc("2027-04-09", "22:00", "America/New_York"), "2027-04-10T02:00:00.000Z");
  assert.equal(zonedToUtc("2027-01-09", "22:00", "America/New_York"), "2027-01-10T03:00:00.000Z");
  assert.equal(zonedToUtc("2027-03-13", "18:00", "America/Chicago"), "2027-03-14T00:00:00.000Z");
  // 02:00–02:59 does not exist on the spring-forward day; it moves forward by the gap.
  assert.equal(zonedToUtc("2027-03-14", "02:00", "America/New_York"), "2027-03-14T07:00:00.000Z");
  assert.equal(zonedToUtc("2027-03-14", "02:30", "America/New_York"), "2027-03-14T07:30:00.000Z");
  // 01:30 happens twice on the fall-back day; the earlier one is used.
  assert.equal(zonedToUtc("2027-11-07", "01:30", "America/New_York"), "2027-11-07T05:30:00.000Z");
  assert.deepEqual(utcToZoned("2027-04-10T02:00:00.000Z", "America/New_York"), { date: "2027-04-09", time: "22:00" });
  assert.throws(() => zonedToUtc("04/09/2027", "22:00", "America/New_York"), /YYYY-MM-DD/);
});

test("US states map between Flite names and Cohost codes", () => {
  assert.equal(stateCode("New York"), "NY");
  assert.equal(stateCode("district of columbia"), "DC");
  assert.equal(stateName("ny"), "New York");
  assert.equal(stateCode("Ontario"), "ONTARIO");
  assert.equal(stateName("Ontario"), "Ontario");
});

test("HTML descriptions become plain text", () => {
  assert.equal(htmlToText("<p>Doors &amp; music</p><p>Line one<br>line two&nbsp;&#8212; late</p>"), "Doors & music\n\nLine one\nline two — late");
});

// ---- events

test("every captured event converts to a Cohost event", () => {
  for (const flite of liveEvents) {
    const cohost = fliteEventToCohost(source, flite);
    assert.equal(cohost.id, `urn:1:company_test:source_test:/events/${flite._id}`);
    assert.equal(cohost.refId, flite._id);
    assert.equal(cohost.tz, flite.timeZoneId);
    assert.ok(Date.parse(cohost.end) > Date.parse(cohost.start), `${flite._id} ends after it starts`);
    assert.equal(cohost.status, flite.isEventEnd ? "ended" : flite.status === "Approved" ? "live" : "queued");
    assert.equal(cohost.location?.address?.region.length, 2);
    assert.equal(cohost.currency, "USD");
    assert.ok(cohost.summary.length > 0);
    assert.doesNotMatch(JSON.stringify(cohost), /NaN|undefined|Invalid Date/);
  }
});

test("captured events round-trip Flite → Cohost → Flite", () => {
  for (const flite of [...liveEvents, documented<FliteEvent>("event")]) {
    const back = cohostEventToFlite(fliteEventToCohost(source, flite));
    for (const field of EVENT_FIELDS) assert.equal(back[field], flite[field], `${flite._id}.${field}`);
    assert.equal(back.eventId, flite._id);
    assert.equal(back.description, flite.description);
    assert.equal(back.zipCode, flite.zipCode ?? "");
    if ("showEvent" in flite) assert.equal(back.showEvent, String(flite.showEvent));
    if ("rsvpCapacity" in flite) assert.equal(back.rsvpCapacity, flite.rsvpCapacity);
  }
});

test("overnight event: 22:00–02:00 local is a four-hour UTC window", () => {
  const cohost = fliteEventToCohost(source, event, { currency: "usd" });
  assert.equal(cohost.start, "2026-07-05T02:00:00.000Z");
  assert.equal(cohost.end, "2026-07-05T06:00:00.000Z");
  assert.equal(cohost.capacity, 100);
  assert.deepEqual(cohost.flyer, { url: "https://example.com/flyer.png" });
  assert.equal(cohost.location?.address?.formattedAddress, "1 Example Street, Brooklyn, NY 11201");
  // Same date written for both ends: the end still falls after the start.
  const sameDate = fliteEventToCohost(source, { ...event, endDate: event.startDate });
  assert.equal(sameDate.end, "2026-07-05T06:00:00.000Z");
});

test("event status and visibility", () => {
  assert.equal(fliteEventToCohost(source, { ...event, status: "Pending" }).status, "queued");
  assert.equal(fliteEventToCohost(source, { ...event, status: "Pending" }).public, false);
  assert.equal(fliteEventToCohost(source, { ...event, isEventEnd: true }).status, "ended");
  assert.equal(fliteEventToCohost(source, { ...event, showEvent: false }).public, false);
  assert.equal(fliteEventToCohost(source, { ...event, hostFlyer: [] }).flyer, null);
});

test("a Cohost-authored event converts to Flite create properties", () => {
  const props = cohostEventToFlite({
    id: "cohost_event",
    companyId: "c",
    organizerId: null,
    name: "Rooftop Night",
    summary: "Rooftop party",
    description: { text: "Rooftop party.\n\nBring <ID> & a friend." },
    tz: "America/Los_Angeles",
    start: "2027-06-01T03:00:00.000Z",
    end: "2027-06-01T08:00:00.000Z",
    isSeries: false,
    status: "draft",
    public: false,
    flyer: null,
    currency: "USD",
    location: {
      venueId: null, placeId: null, name: "The Roof", geometry: null, timezone: "America/Los_Angeles",
      address: { address_1: "9 Sky Rd", city: "Los Angeles", region: "CA", postal_code: "90012", country: "US" },
    },
    created: "2027-01-01T00:00:00.000Z",
    changed: "2027-01-01T00:00:00.000Z",
  });
  assert.deepEqual(props, {
    eventName: "Rooftop Night",
    description: "<p>Rooftop party.</p><p>Bring &lt;ID&gt; &amp; a friend.</p>",
    venueName: "The Roof",
    venueLocation: "9 Sky Rd",
    city: "Los Angeles",
    state: "California",
    zipCode: "90012",
    showEvent: "false",
    startDate: "2027-05-31",
    startTime: "20:00",
    endDate: "2027-06-01",
    endTime: "01:00",
  });
});

test("a captured event ending in the DST gap keeps its Flite times until rescheduled", () => {
  const flite = liveEvents.find((e) => e.endDate === "2027-03-14" && e.endTime === "02:00");
  assert.ok(flite, "fixture has an event ending at 02:00 on the spring-forward night");
  const cohost = fliteEventToCohost(source, flite);
  assert.equal(cohost.end, "2027-03-14T07:00:00.000Z"); // 03:00 EDT
  assert.equal(cohostEventToFlite(cohost).endTime, "02:00");
  const moved = cohostEventToFlite({ ...cohost, end: "2027-03-14T08:00:00.000Z" });
  assert.deepEqual([moved.endDate, moved.endTime, moved.startTime], ["2027-03-14", "04:00", flite.startTime]);
});

test("an edited Cohost description replaces Flite's HTML", () => {
  const cohost = fliteEventToCohost(source, event);
  const back = cohostEventToFlite({ ...cohost, description: { text: "New copy" } });
  assert.equal(back.description, "<p>New copy</p>");
});

// ---- tickets

test("captured ticket types round-trip Flite → Cohost → Flite", () => {
  const all = [...liveTickets, ...live<FliteEventWithTickets>("event-1-with-tickets").tickets, documented<FliteTicket>("ticket")];
  for (const flite of all) {
    const cohost = fliteTicketToCohost(source, flite);
    assert.equal(cohost.id, `urn:1:company_test:source_test:/events/${flite.eventId}/tickets/${flite._id}`);
    assert.equal(cohost.capacity, flite.capacity);
    assert.equal(cohost.quantitySold, flite.sold);
    assert.equal(cohost.costs.cost, `USD,${Math.round(flite.ticketPrice * 100)}`);
    const back = cohostTicketToFlite(cohost);
    assert.deepEqual(back, {
      eventId: flite.eventId,
      ticketId: flite._id,
      ticketName: flite.ticketName,
      ticketPrice: flite.ticketPrice,
      capacity: flite.capacity,
      availability: flite.availability,
      description: flite.description,
      maxCart: flite.maxCart,
      ...(flite.ebTicketId ? { ebTicketId: flite.ebTicketId } : {}),
    });
  }
});

test("ticket availability, sold-out, free and donation pricing", () => {
  const base = event.tickets[0];
  const status = (patch: Partial<FliteTicket>) => fliteTicketToCohost(source, { ...base, ...patch }).status;
  assert.equal(status({ availability: "true" }), "live");
  assert.equal(status({ availability: "true", sold: 100 }), "sold-out");
  assert.equal(status({ availability: "hide" }), "hidden");
  assert.equal(status({ availability: "soon" }), "draft");
  assert.equal(status({ availability: "false" }), "unavailable");
  // Sold out in Cohost is still "true" in Flite, which derives it from sold >= capacity.
  assert.equal(cohostTicketToFlite(fliteTicketToCohost(source, { ...base, sold: 100 })).availability, "true");
  const free = fliteTicketToCohost(source, { ...base, ticketPrice: 0 });
  assert.equal(free.priceCategory, "free");
  assert.equal(cohostTicketToFlite(free).ticketPrice, 0);
  assert.throws(() => cohostTicketToFlite({ ...free, priceCategory: "donation" }), /donation/);
  assert.equal(fliteTicketToCohost(source, base, { currency: "cad" }).costs.total, "CAD,1234");
});

// ---- orders

test("every captured order, list and detail, converts to a Cohost order", () => {
  for (const flite of [...detailOrders, ...listOrders]) {
    const cohost = fliteOrderToCohost(source, flite, { eventId: "event_from_request" });
    assert.equal(cohost.id, `urn:1:company_test:source_test:/orders/${flite._id}`);
    assert.equal(cohost.currency, flite.currency.toUpperCase());
    assert.equal(cohost.items.length, flite.tickets.length);
    assert.equal(cohost.costs.total, `${cohost.currency},${Math.round(flite.totalAmount * 100)}`);
    for (const item of cohost.items) assert.ok(item.offering.name);
    assert.doesNotMatch(JSON.stringify(cohost), /NaN|undefined/);
  }
});

test("detail orders round-trip Flite → Cohost → Flite", () => {
  for (const flite of [...detailOrders, order]) {
    const back = cohostOrderToFlite(fliteOrderToCohost(source, flite));
    // Flite returns "USD" in its docs and "usd" live; Cohost normalizes, and the reverse writes lower case.
    assert.deepEqual(
      { ...back, currency: back.currency.toUpperCase(), tickets: back.tickets.map((t) => ({ ...t, ebTicketId: t.ebTicketId || undefined })) },
      { ...flite, currency: flite.currency.toUpperCase(), tickets: flite.tickets.map((t) => ({ ...t, ebTicketId: t.ebTicketId || undefined })) },
    );
  }
});

test("order money: total paid, custom fee, discount", () => {
  const cohost = fliteOrderToCohost(source, order);
  assert.deepEqual(cohost.costs, {
    subtotal: "USD,1200",
    fee: "USD,34",
    tax: "USD,0",
    discount: "USD,125",
    delivery: "USD,0",
    gross: "USD,1234",
    preDiscount: "USD,1359",
    total: "USD,1234",
  });
});

test("list orders whose tickets lack a ticketId (the documented example) are rejected", () => {
  const [documentedListOrder] = documented<FliteOrdersPage>("orders-page").orders;
  assert.throws(
    () => fliteOrderToCohost(source, documentedListOrder, { eventId: "e" }),
    /has no ticketId; convert the order detail instead/,
  );
});

test("list orders need the event ID from the request", () => {
  const [listed] = listOrders;
  assert.throws(() => fliteOrderToCohost(source, listed), /eventId/);
  const cohost = fliteOrderToCohost(source, listed, { eventId: "65f1e0000000000000000002" });
  assert.equal(cohost.contextId, "urn:1:company_test:source_test:/events/65f1e0000000000000000002");
  assert.equal(cohost.items[0].costs.discount, `USD,${Math.round(listed.tickets[0].discountAmount * 100)}`);
});

test("a Cohost order item with quantity 2 becomes two Flite tickets", () => {
  const cohost = fliteOrderToCohost(source, order);
  const item = { ...cohost.items[0], quantity: 2, costs: { ...cohost.items[0].costs, total: "USD,2000" } };
  item.meta = { ...item.meta, barcodes: ["b1", "b2"], attendees: [] };
  const back = cohostOrderToFlite({ ...cohost, items: [item], status: "refunded", meta: {} });
  assert.deepEqual(back.tickets.map((t) => [t.barcode, t.totalAmount, t.ticketId]), [["b1", 10, "ticket_1"], ["b2", 10, "ticket_1"]]);
  assert.equal(back.status, "Refunded");
  assert.equal(back._id, "order_1");
  assert.equal(back.eventId, "event_1");
});

// ---- actions

test("flite-to-cohost converts an event with its ticket types", () => {
  const flite = live<FliteEventWithTickets>("event-1-with-tickets");
  const result = fliteToCohostAction.execute({ ...source, resource: "event", data: flite });
  assert.equal(result.data.id, `urn:1:company_test:source_test:/events/${flite._id}`);
  assert.deepEqual(result.tickets?.map((t) => [t.refId, t.sorting]), flite.tickets.map((t, i) => [t._id, i]));
  assert.throws(() => fliteToCohostAction.execute({ ...source, resource: "event", data: [] }), /object/);
  assert.equal(fliteToCohostAction.requiresAuth, false);
});

test("cohost-to-flite-data reverses flite-to-cohost for each resource", () => {
  for (const [resource, data] of [["event", event], ["ticket", event.tickets[0]], ["order", order]] as const) {
    const cohost = fliteToCohostAction.execute({ ...source, resource, data }).data;
    const back = cohostToFliteDataAction.execute({ resource, data: cohost }).data;
    assert.equal((back as { eventName?: string; ticketName?: string; _id?: string }).eventName ?? (back as { ticketName?: string }).ticketName ?? (back as { _id: string })._id,
      resource === "event" ? event.eventName : resource === "ticket" ? event.tickets[0].ticketName : order._id);
  }
  assert.equal(cohostToFliteDataAction.requiresAuth, false);
});
