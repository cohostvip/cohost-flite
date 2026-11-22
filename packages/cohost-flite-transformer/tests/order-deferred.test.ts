import { test } from "node:test";
import assert from "node:assert/strict";
import { fliteOrderToCohost } from "../convert/order.ts";
import transformOrder from "../actions/transform-order.ts";
import { source } from "../../../tests/fixtures.ts";
import { readCapture } from "../../../tests/live-fixtures.ts";
import type { FliteOrder } from "@cohost/flite-types";

const base = () => readCapture<{ data: FliteOrder }>("event-9-order-1").body.data;
const paid = (): FliteOrder => {
  const o = structuredClone(base());
  o.totalAmount = 50;
  o.tickets = o.tickets.map((t) => ({ ...t, totalAmount: 50 / o.tickets.length }));
  return o;
};
const run = (input: Record<string, unknown>) =>
  (transformOrder.execute as (i: never) => { order: Record<string, unknown>; context: { urn: string } })(input as never);

test("paid order is deferred with cents totals, paymentDate, items and URNs", () => {
  const o = paid();
  const r = fliteOrderToCohost(source, o);
  assert.equal(r.paymentMethod, "deferred");
  assert.equal(r.status, "placed");
  assert.equal(r.currency, "USD");
  assert.equal(r.costs.total, "USD,5000");
  assert.equal(r.costs.gross, "USD,5000");
  assert.ok(o.paymentDate);
  assert.equal((r.meta as { flite: { paymentDate: string } }).flite.paymentDate, o.paymentDate);
  assert.equal(r.items.length, o.tickets.length);
  assert.match(String(r.contextId), /:\/events\/65f1e0000000000000000002$/);
  assert.match(String(r.urn), /:\/orders\/65f1e0000000000000000001$/);
  assert.equal(fliteOrderToCohost(source, o).urn, r.urn);
});

test("free order is deferred", () => {
  const o = structuredClone(base());
  assert.equal(o.totalAmount, 0);
  assert.equal(fliteOrderToCohost(source, o).paymentMethod, "deferred");
});

test("refunded order stays refunded but deferred", () => {
  const o = paid();
  o.status = "Refunded";
  const r = fliteOrderToCohost(source, o);
  assert.equal(r.status, "refunded");
  assert.equal(r.paymentMethod, "deferred");
});

test("transform-order derives flite-<env> connection when only env given", () => {
  const { connectionId: _c, ...rest } = source;
  const { order, context } = run({ ...rest, env: "sandbox", order: paid() });
  assert.equal(order.paymentMethod, "deferred");
  assert.match(context.urn, new RegExp(`:flite-sandbox:/orders/`));
  assert.match(String(order.contextId), /:flite-sandbox:\/events\//);
  assert.equal(order.urn, context.urn);
  assert.throws(() => run({ ...rest, order: paid() }), /connectionId/);
  assert.match(run({ ...source, env: "x", order: paid() }).context.urn, new RegExp(`:${source.connectionId}:`));
});
