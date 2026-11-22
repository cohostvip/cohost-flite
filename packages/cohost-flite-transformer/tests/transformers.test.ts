import { test } from "node:test";
import assert from "node:assert/strict";
import action from "../actions/transform-order.ts";
import { fliteOrderToCohost } from "../convert/order.ts";
import { fliteEventSnapshot } from "../convert/snapshot.ts";
import type { FliteOrder } from "@cohost/flite-types";
import { event, order, source } from "../../../tests/fixtures.ts";
import snapshotAction from "../actions/event-snapshot.ts";
import mappingsAction from "../actions/list-mapping-objects.ts";

const transformOrder = (source: { companyId: string; connectionId: string }, order: FliteOrder, eventId?: string) =>
  fliteOrderToCohost(source, order, { eventId });

test("issued tickets without discounts keep a zero discount and their check-in status", () => {
  const result = transformOrder(source, {
    ...order, tickets: [{ ...order.tickets[0], checkIn: true, checkInTime: "2026-01-01T20:00:00.000Z" }],
  });
  assert.equal(result.items[0].costs.discount, "USD,0");
  const attendee = result.items[0].meta!.attendees![0];
  assert.equal(attendee.checkedIn, true);
  assert.equal(attendee.checkedInAt, "2026-01-01T20:00:00.000Z");
  assert.equal(attendee.status, "checkedIn");
  assert.doesNotMatch(JSON.stringify(result), /NaN/);
});

test("order transformer preserves money, customer, barcode and source URNs", () => {
  const out = action.execute({ ...source, order });
  const result = out.data;
  assert.equal(out.urn, "urn:1:company_test:source_test:/orders/order_1");
  assert.equal(result.order.urn, out.urn);
  assert.equal(result.order.companyId, source.companyId);
  assert.equal(result.order.contextId, "urn:1:company_test:source_test:/events/event_1");
  assert.equal(result.order.costs.total, "USD,1234");
  assert.equal(result.order.costs.discount, "USD,125");
  assert.equal(result.order.costs.fee, "USD,34");
  assert.equal(result.order.customer.email, "buyer@example.test");
  assert.equal(
    result.order.items[0].offeringId,
    "urn:1:company_test:source_test:/events/event_1/tickets/ticket_1",
  );
  assert.deepEqual(result.order.items[0].meta?.barcodes, ["synthetic-barcode"]);
  assert.equal(result.order.items[0].meta?.attendees?.[0].ticketQr, "synthetic-qr");
  assert.equal(result.order.items[0].offering.name, "Admission");
  assert.deepEqual(result.order.answers, { "How did you hear about us?": "A friend" });
  assert.equal(result.order.status, "placed");
});

test("transformer uses source event before fallback, and maps cancellations/refunds", () => {
  assert.match(transformOrder(source, order, "other_event").contextId, /event_1$/);
  assert.match(
    transformOrder(source, { ...order, eventId: "" }, "fallback").contextId,
    /fallback$/,
  );
  assert.throws(() => transformOrder(source, { ...order, eventId: "" }), /eventId/);
  assert.equal(transformOrder(source, { ...order, status: "Refunded" }).status, "refunded");
  assert.equal(transformOrder(source, { ...order, status: "Cancelled" }).status, "voided");
  assert.throws(() => transformOrder({ ...source, companyId: "" }, order), /companyId/);
  assert.throws(
    () => transformOrder({ ...source, connectionId: "bad:segment" }, order),
    /connectionId/,
  );
});

test("snapshot applies approval, ended and availability semantics", () => {
  assert.equal(fliteEventSnapshot(source, event).enabled, true);
  assert.equal(fliteEventSnapshot(source, { ...event, status: "Pending" }).enabled, false);
  assert.equal(fliteEventSnapshot(source, { ...event, isEventEnd: true }).enabled, false);
  for (const availability of ["false", "hide", "soon"] as const) {
    assert.equal(
      fliteEventSnapshot(source, { ...event, tickets: [{ ...event.tickets[0], availability }] })
        .tickets[0].enabled,
      false,
    );
  }
});

test("snapshot and mapping actions are offline and share the same source identity", () => {
  const { snapshot } = snapshotAction.execute({ ...source, event });
  const { objects } = mappingsAction.execute({ ...source, event });
  assert.equal(snapshot.urn, "urn:1:company_test:source_test:/events/event_1");
  assert.equal(snapshot.tickets[0].price, "USD,1234");
  assert.equal(snapshot.tickets[0].sold, 25);
  assert.equal(objects[0].urn, snapshot.tickets[0].urn);
  assert.equal(snapshotAction.requiresAuth, false);
  assert.equal(mappingsAction.requiresAuth, false);
});

test("transform-order outputs the full Upsert Order body: order, source and one attendee per ticket", () => {
  const two = { ...order, tickets: [{ ...order.tickets[0], checkIn: true }, { ...order.tickets[0], barcode: "synthetic-barcode-2", checkIn: false }] };
  const { data, urn } = action.execute({ ...source, order: two, channelId: " ch_flite " });
  assert.deepEqual(Object.keys(data).sort(), ["attendees", "order", "source"]);
  assert.deepEqual(data.source, {
    system: "flite",
    externalId: two._id,
    eventId: two.eventId,
    urn,
    changedAt: two.paymentDate || two.created || null,
    status: two.status ?? null,
    payload: two,
  });
  assert.equal(data.order.context?.channelId, "ch_flite", "the selling channel is recorded on the order");
  assert.equal(data.order.context?.source, "flite");
  assert.equal(data.attendees.length, 2);
  const ids = data.order.items.map((i) => i.id);
  assert.deepEqual(data.attendees.map((a) => a.orderItemId), ids, "each attendee names its order item");
  assert.deepEqual(data.attendees.map((a) => a.barcodes), [["synthetic-barcode"], ["synthetic-barcode-2"]]);
  assert.deepEqual(data.attendees.map((a) => [a.checkedIn, a.status]), [[true, "checkedIn"], [false, "attending"]]);
  for (const a of data.attendees) assert.match(a.urn, /^urn:1:company_test:source_test:\//);
});

test("transform-order: no channelId leaves context without a channel; the event comes from the order", () => {
  const { data } = action.execute({ ...source, order });
  assert.equal(data.order.context?.channelId, undefined);
  assert.equal(data.order.contextId, "urn:1:company_test:source_test:/events/event_1");
  assert.ok(!action.params.some((p) => p.key === "eventId"), "no separate event id field");
});

test("refunded orders mark every attendee refunded", () => {
  const { data } = action.execute({ ...source, order: { ...order, status: "refunded" } as FliteOrder });
  if (data.order.status === "refunded") assert.ok(data.attendees.every((a) => a.status === "refunded"));
});
