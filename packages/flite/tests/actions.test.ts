import { test } from "node:test";
import assert from "node:assert/strict";
import getOrder from "../actions/get-order.ts";
import listOrders from "../actions/list-orders.ts";
import getEvent from "../actions/get-event.ts";
import controlEvent from "../actions/control-event.ts";
import updateTicket from "../actions/update-ticket.ts";
import getWebhook from "../actions/get-webhook.ts";
import registerWebhook from "../actions/register-webhook.ts";
import { API_URL, resourceId, STAGING_API_URL } from "../lib/client.ts";
import { context, event, order } from "../../../tests/fixtures.ts";

test("live empty-order HTTP 404 is an empty page, while other 404s still fail", async () => {
  const empty = context([Response.json({ success: false, message: "No completed orders found" }, { status: 404 })]);
  assert.deepEqual(await listOrders.execute({ eventId: "event_1", page: 3 }, empty.ctx), {
    orders: [], count: 0, pagination: { hasMore: false, currentPage: 3, nextPage: null },
  });
  const missing = context([Response.json({ success: false, message: "Event not found" }, { status: 404 })]);
  await assert.rejects(listOrders.execute({ eventId: "event_1" }, missing.ctx), /404/);
});

test("get-order accepts both captured response envelopes and encodes IDs", async () => {
  for (const data of [order, { order }]) {
    const { ctx, requests } = context([{ success: true, data }]);
    assert.deepEqual(await getOrder.execute({ orderId: "id&injected=true" }, ctx), { order });
    assert.equal(requests[0].url, `${API_URL}/get-order-by-id?orderId=id%26injected%3Dtrue`);
    assert.equal(new Headers(requests[0].init.headers).has("authorization"), false);
  }
});

test("list-orders preserves pagination and follows the selected environment", async () => {
  const pagination = { hasMore: true, currentPage: 2, nextPage: 3 };
  const { ctx, requests } = context(
    [{ success: true, data: { orders: [order], pagination } }],
    true,
  );
  const result = await listOrders.execute({
    eventId: "urn:1:company:connection:/events/event_1",
    page: 2,
  }, ctx);
  assert.deepEqual(result, { orders: [order], count: 1, pagination });
  assert.equal(requests[0].url, `${STAGING_API_URL}/get-orders-by-event?eventId=event_1&page=2`);
});

test("empty orders is a success, but HTTP and application failures throw", async () => {
  const empty = context([{ success: false, message: "No completed orders found" }]);
  assert.equal((await listOrders.execute({ eventId: "event_1" }, empty.ctx)).count, 0);
  for (
    const response of [Response.json({ token: "do-not-echo" }, { status: 401 }), {
      success: false,
      message: "do-not-echo",
    }]
  ) {
    const { ctx } = context([response]);
    await assert.rejects(getOrder.execute({ orderId: "order_1" }, ctx), (error: Error) => {
      assert.match(error.message, /Flite/);
      assert.doesNotMatch(error.message, /do-not-echo/);
      return true;
    });
  }
});

test("malformed successful responses fail instead of silently losing records", async () => {
  const a = context([{ success: true, data: {} }]);
  await assert.rejects(listOrders.execute({ eventId: "event_1" }, a.ctx), /invalid orders/);
  const b = context([{ success: true, data: {} }]);
  await assert.rejects(getOrder.execute({ orderId: "order_1" }, b.ctx), /invalid order/);
});

test("invalid pagination and resource URNs fail before fetching", async () => {
  const { ctx, requests } = context();
  await assert.rejects(
    listOrders.execute({ eventId: "event_1", page: 0 }, ctx),
    /positive integer/,
  );
  assert.throws(() => resourceId("urn:1:c:s:/tickets/t", "events"), /Invalid events/);
  assert.throws(() => resourceId("", "events"), /required/);
  assert.equal(requests.length, 0);
});

test("get-event returns the raw event and its ticket types", async () => {
  const { ctx } = context([{ success: true, data: event }]);
  assert.deepEqual(await getEvent.execute({ eventId: "event_1" }, ctx), { event });
});

test("control-event inverts active to isEventEnd and uses JSON", async () => {
  for (const action of ["start", "stop"] as const) {
    const { ctx, requests } = context([{ success: true, data: {} }]);
    const result = await controlEvent.execute({ eventId: "event_1", action }, ctx);
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      eventId: "event_1",
      isEventEnd: action === "stop",
    });
    assert.equal(requests[0].init.method, "POST");
    assert.equal(new Headers(requests[0].init.headers).get("content-type"), "application/json");
    assert.equal(result.status, action === "stop" ? "ended" : "active");
    // No post-write snapshot request that could turn a successful write into a reported failure.
    assert.equal(requests.length, 1);
  }
});

test("control-ticket preserves zero price/capacity and converts minor units", async () => {
  const { ctx, requests } = context([{ success: true }, { success: true }]);
  for (const price of ["USD,0", "USD,1234"]) {
    await controlEvent.execute({
      eventId: "event_1",
      ticketId: "urn:1:c:s:/events/event_1/tickets/ticket_1",
      action: "start",
      capacity: 0,
      price,
    }, ctx);
  }
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    eventId: "event_1",
    ticketId: "ticket_1",
    availability: "true",
    capacity: 0,
    ticketPrice: 0,
  });
  assert.equal(JSON.parse(String(requests[1].init.body)).ticketPrice, 12.34);
});

test("invalid ticket writes fail before touching Flite", async () => {
  const { ctx, requests } = context();
  for (const price of ["USD,12oops", "EUR,1000", "USD,-1", "USD,1.2"]) {
    await assert.rejects(
      controlEvent.execute({ eventId: "e", ticketId: "t", action: "stop", price }, ctx),
      /Price/,
    );
  }
  await assert.rejects(
    updateTicket.execute({ eventId: "e", ticketId: "t", capacity: -1 }, ctx),
    /Capacity/,
  );
  await assert.rejects(updateTicket.execute({ eventId: "e", ticketId: "t" }, ctx), /at least one/);
  await assert.rejects(
    controlEvent.execute({ eventId: "e", action: "start", price: "USD,1" }, ctx),
    /Ticket ID/,
  );
  assert.equal(requests.length, 0);
});

test("update-ticket supports Flite's hidden/soon states", async () => {
  const { ctx, requests } = context([{ success: true, data: { availability: "hide" } }]);
  const result = await updateTicket.execute({
    eventId: "event_1",
    ticketId: "ticket_1",
    availability: "hide",
  }, ctx);
  assert.deepEqual(result, { result: { availability: "hide" } });
  assert.equal(JSON.parse(String(requests[0].init.body)).availability, "hide");
});

test("webhook registration is idempotent and protects existing consumers", async () => {
  const url = "https://hooks.example.test/flite";
  const unchanged = context([{ success: true, webhookUrl: url }]);
  assert.equal((await registerWebhook.execute({ webhookUrl: url }, unchanged.ctx)).changed, false);
  assert.equal(unchanged.requests.length, 1);
  const occupied = context([{ success: true, webhookUrl: "https://other.example.test/" }]);
  await assert.rejects(
    registerWebhook.execute({ webhookUrl: url }, occupied.ctx),
    /replaceExisting/,
  );
  assert.equal(occupied.requests.length, 1);
  const changed = context([{ success: true, webhookUrl: "https://other.example.test/" }, {
    success: true,
  }]);
  assert.equal(
    (await registerWebhook.execute({ webhookUrl: url, replaceExisting: true }, changed.ctx))
      .changed,
    true,
  );
  assert.equal(changed.requests[1].init.method, "PUT");
  assert.deepEqual(JSON.parse(String(changed.requests[1].init.body)), { webhookUrl: url });
});

test("get-webhook distinguishes no URL from a failure; registration rejects unsafe URLs", async () => {
  const empty = context([{ success: true }]);
  assert.deepEqual(await getWebhook.execute({}, empty.ctx), { webhookUrl: null });
  const failed = context([{ success: false }]);
  await assert.rejects(
    registerWebhook.execute({ webhookUrl: "https://hooks.example.test/flite" }, failed.ctx),
    /failure/,
  );
  assert.equal(failed.requests.length, 1);
  const { ctx, requests } = context();
  for (
    const webhookUrl of ["http://hooks.example.test/", "https://user:pass@hooks.example.test/"]
  ) {
    await assert.rejects(registerWebhook.execute({ webhookUrl }, ctx), /HTTPS/);
  }
  assert.equal(requests.length, 0);
});

test("the webhook URL is read from Flite's data envelope, so an existing consumer is protected", async () => {
  // Live GET /api/get-webhook-url answers { success, data: { webhookUrl } }.
  const url = "https://other.example.test/flite";
  const { ctx } = context([{ success: true, data: { webhookUrl: url } }]);
  assert.deepEqual(await getWebhook.execute({}, ctx), { webhookUrl: url });
  const occupied = context([{ success: true, data: { webhookUrl: url } }]);
  await assert.rejects(
    registerWebhook.execute({ webhookUrl: "https://hooks.example.test/flite" }, occupied.ctx),
    /replaceExisting/,
  );
  assert.equal(occupied.requests.length, 1, "no PUT may replace an existing consumer");
});
