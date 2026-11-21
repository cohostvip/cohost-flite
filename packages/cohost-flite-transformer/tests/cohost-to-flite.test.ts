import { test } from "node:test";
import assert from "node:assert/strict";
import transformer from "../actions/cohost-to-flite.ts";
import updateTicket from "../../flite/actions/update-ticket.ts";
import controlEvent from "../../flite/actions/control-event.ts";
import { context } from "../../../tests/fixtures.ts";

test("Cohost event status maps to directly executable Flite action inputs", async () => {
  for (
    const status of [
      "live",
      "started",
      "draft",
      "queued",
      "ended",
      "completed",
      "canceled",
      "archived",
    ]
  ) {
    const result = transformer.execute({
      resource: "event",
      data: { status, id: "cohost_id" },
      eventId: "urn:1:c:flite_source:/events/flite_event",
    });
    assert.equal(result.actionKey, "control-event");
    if (result.actionKey !== "control-event") throw new Error("Expected event conversion");
    assert.equal(result.params.eventId, "flite_event");
    assert.equal(result.params.action, ["live", "started"].includes(status) ? "start" : "stop");
    const { ctx, requests } = context([{ success: true }]);
    await controlEvent.execute(result.params, ctx);
    assert.equal(
      JSON.parse(String(requests[0].init.body)).isEventEnd,
      result.params.action === "stop",
    );
  }
});

test("ticket conversion preserves total capacity and converts only base cost to major units", async () => {
  const result = transformer.execute({
    resource: "ticket",
    eventId: "flite_event",
    ticketId: "flite_ticket",
    data: {
      id: "cohost_ticket",
      status: "hidden",
      capacity: 100,
      quantitySold: 25,
      costs: { cost: "USD,1234", total: "USD,1500" },
    },
  });
  assert.deepEqual(result, {
    actionKey: "update-ticket",
    params: {
      eventId: "flite_event",
      ticketId: "flite_ticket",
      availability: "hide",
      capacity: 100,
      ticketPrice: 12.34,
    },
  });
  if (result.actionKey !== "update-ticket") throw new Error("Expected ticket conversion");
  const { ctx, requests } = context([{ success: true }]);
  await updateTicket.execute(result.params, ctx);
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), result.params);
});

test("zero values, free tickets, and inactive ticket states remain explicit", () => {
  for (
    const [status, availability] of [["live", "true"], ["draft", "soon"], ["sold-out", "false"], [
      "archived",
      "false",
    ]]
  ) {
    const result = transformer.execute({
      resource: "ticket",
      eventId: "e",
      ticketId: "t",
      data: { status, capacity: 0, priceCategory: "free" },
    });
    assert.deepEqual(result.params, {
      eventId: "e",
      ticketId: "t",
      availability,
      capacity: 0,
      ticketPrice: 0,
    });
  }
  const result = transformer.execute({
    resource: "ticket",
    eventId: "e",
    ticketId: "t",
    data: { enabled: false, price: "USD,0" },
  });
  assert.deepEqual(result.params, {
    eventId: "e",
    ticketId: "t",
    availability: "false",
    ticketPrice: 0,
  });
});

test("conversion rejects unknown statuses, unsafe amounts and unsupported pricing", () => {
  for (
    const data of [
      { status: "mystery" },
      { costs: { cost: "EUR,1234" } },
      { costs: { cost: "USD,-1" } },
      { price: "USD,1.5" },
      { price: "USD,9007199254740992" },
      { capacity: -1 },
      { priceCategory: "donation" },
      { currency: "EUR", priceCategory: "free" },
      {},
    ]
  ) {
    assert.throws(() =>
      transformer.execute({ resource: "ticket", eventId: "e", ticketId: "t", data })
    );
  }
  assert.throws(() =>
    transformer.execute({ resource: "event", eventId: "e", data: { status: "mystery" } })
  );
  assert.throws(() => transformer.execute({ resource: "event", eventId: "e", data: [] }));
});

test("mapping identities are required; Cohost IDs and internal URNs are never inferred", () => {
  assert.throws(
    () =>
      transformer.execute({
        resource: "event",
        eventId: "",
        data: { id: "cohost_id", status: "live" },
      }),
    /mapped Flite/,
  );
  assert.throws(
    () =>
      transformer.execute({
        resource: "event",
        eventId: "urn:1:c:cohost-falcon:/events/e",
        data: { status: "live" },
      }),
    /not a Cohost/,
  );
  assert.throws(
    () =>
      transformer.execute({ resource: "ticket", eventId: "e", data: { id: "t", status: "live" } }),
    /mapped Flite/,
  );
  const result = transformer.execute({
    resource: "ticket",
    eventId: "e",
    ticketId: "urn:1:c:flite_source:/events/e/tickets/t",
    data: { capacity: 4 },
  });
  assert.deepEqual(result.params, { eventId: "e", ticketId: "t", capacity: 4 });
});
