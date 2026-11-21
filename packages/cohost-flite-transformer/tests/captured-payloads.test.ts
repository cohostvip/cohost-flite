import { test } from "node:test";
import assert from "node:assert/strict";
import { fliteOrderToCohost } from "../convert/order.ts";
import { fliteEventSnapshot } from "../convert/snapshot.ts";
import { source } from "../../../tests/fixtures.ts";
import { readCapture, readFixture } from "../../../tests/live-fixtures.ts";
import type { FliteBuyer, FliteEventWithTickets, FliteOrder, FliteOrderListTicket, FliteTicket } from "@cohost/flite-types";

test("captured order converts with zero discounts and keeps attendee identity", () => {
  const order = readCapture<{ data: FliteOrder }>("event-9-order-1").body.data;
  const { attendees } = readFixture<{
    attendees: Array<{ orderId: string; eventId: string; buyer: FliteBuyer; ticket: FliteOrderListTicket }>;
  }>("attendees.derived.json");
  const result = fliteOrderToCohost(source, order);
  assert.equal(result.status, "placed");
  assert.equal(result.currency, "USD");
  assert.equal(result.items.length, attendees.length);
  assert.equal(result.items[0].costs.discount, "USD,0");
  assert.equal(result.items[0].meta?.attendees?.[0].checkedIn, order.tickets[0].checkIn);
  assert.deepEqual(result.items[0].meta?.barcodes, [attendees[0].ticket.barcode]);
  assert.equal(result.customer.email, attendees[0].buyer.email);
  assert.equal(attendees[0].orderId, order._id);
  assert.equal(attendees[0].eventId, order.eventId);
  assert.doesNotMatch(JSON.stringify(result), /NaN|undefined/);
});

test("captured event snapshot keeps ticket identities and prices", () => {
  const event = readCapture<{ data: FliteEventWithTickets }>("event-1-with-tickets").body.data;
  const snapshot = fliteEventSnapshot(source, event);
  const { tickets } = readFixture<{ tickets: FliteTicket[] }>("ticket-types.derived.json");
  assert.equal(snapshot.tickets.length, 2);
  for (const ticket of tickets) {
    assert.equal(ticket.eventId, event._id);
    const converted = snapshot.tickets.find((item) => item.id === ticket._id);
    assert.ok(converted);
    assert.equal(converted.price, `USD,${Math.round(ticket.ticketPrice * 100)}`);
  }
});
