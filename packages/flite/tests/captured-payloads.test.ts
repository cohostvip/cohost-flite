import { test } from "node:test";
import assert from "node:assert/strict";
import getOrder from "../actions/get-order.ts";
import listOrders from "../actions/list-orders.ts";
import getEvent from "../actions/get-event.ts";
import { production } from "../auth/bearer-token.ts";
import { context } from "../../../tests/fixtures.ts";
import { readCapture, replayCapture } from "../../../tests/live-fixtures.ts";
import type { FliteEvent, FliteEventWithTickets, FliteOrder } from "@cohost/flite-types";

test("captured partner organization response passes the credential check", async () => {
  const { ctx } = context([replayCapture("organizations-partner")]);
  const result = await production.test!({ credential: { token: "fixture-token" } }, ctx);
  assert.equal(result.ok, true);
});

test("captured order list and detail retain order identity and their different field sets", async () => {
  const detail = readCapture<{ data: FliteOrder }>("event-9-order-1").body.data;
  const { ctx } = context([replayCapture("event-9-orders-page-1"), replayCapture("event-9-order-1")]);
  const page = await listOrders.execute({ eventId: detail.eventId }, ctx);
  const result = await getOrder.execute({ orderId: detail._id }, ctx);
  assert.equal(page.count, 1);
  assert.equal(page.orders[0]._id, result.order._id);
  // The live list omits eventId; consumers already have it from the request.
  assert.equal("eventId" in page.orders[0], false);
  assert.equal(page.orders[0].orderNumber, result.order.orderNumber);
  assert.deepEqual(result.order, detail);
  assert.equal("discountAmount" in result.order.tickets[0], false);
});

test("all captured empty-order responses replay as empty pages", async () => {
  for (let i = 1; i <= 8; i++) {
    const { ctx } = context([replayCapture(`event-${i}-orders-page-1`)]);
    assert.deepEqual(await listOrders.execute({ eventId: "fixture-event", page: 2 }, ctx), {
      orders: [], count: 0, pagination: { hasMore: false, currentPage: 2, nextPage: null },
    });
  }
});

test("captured event detail with tickets is accepted by the API action", async () => {
  const expected = readCapture<{ data: FliteEventWithTickets }>("event-1-with-tickets").body.data;
  const { ctx } = context([replayCapture("event-1-with-tickets")]);
  const { event } = await getEvent.execute({ eventId: expected._id }, ctx);
  assert.deepEqual(event, expected);
  assert.equal(event.tickets.length, 2);
  assert.equal(readCapture<{ data: FliteEvent }>("event-1").body.data._id, event._id);
});
