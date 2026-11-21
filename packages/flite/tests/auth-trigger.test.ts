import { test } from "node:test";
import assert from "node:assert/strict";
import { production, staging } from "../auth/bearer-token.ts";
import trigger, { normalizeDelivery } from "../triggers/order-placed.ts";
import { API_URL, STAGING_API_URL } from "../lib/client.ts";
import { context, order } from "../../../tests/fixtures.ts";

test("each auth method signs only its own environment", async () => {
  for (
    const [auth, base, wrong] of [[production, API_URL, STAGING_API_URL], [
      staging,
      STAGING_API_URL,
      API_URL,
    ]] as const
  ) {
    const { ctx } = context();
    const signed = await auth.sign!({
      credential: { token: "test-token" },
      request: { url: `${base}/get-order-by-id`, method: "GET", headers: {} },
    }, ctx);
    assert.equal(signed.headers.authorization, "Bearer test-token");
    for (
      const url of [
        `${wrong}/get-order-by-id`,
        "https://evil.example.test/api/get-order-by-id",
        `${base.replace("https:", "http:")}/get-order-by-id`,
      ]
    ) {
      assert.throws(
        () =>
          auth.sign!({
            credential: { token: "test-token" },
            request: { url, method: "GET", headers: {} },
          }, ctx),
        /Refusing/,
      );
    }
  }
});

test("credential test checks application success as well as HTTP status", async () => {
  const { ctx, requests } = context([
    { success: true },
    { success: false },
    new Response("", { status: 401 }),
  ]);
  assert.deepEqual(await production.test({ credential: { token: "test-token" } }, ctx), {
    ok: true,
  });
  assert.equal((await production.test({ credential: { token: "test-token" } }, ctx)).ok, false);
  assert.equal((await production.test({ credential: { token: "test-token" } }, ctx)).ok, false);
  assert.equal(new Headers(requests[0].init.headers).get("authorization"), "Bearer test-token");
  assert.equal(requests[0].url, `${API_URL}/get-all-orgs-partner`);
});

test("webhook normalizer ignores tests and unknown events, rejects missing order IDs", () => {
  assert.equal(normalizeDelivery({ action: "test" }), null);
  assert.equal(normalizeDelivery({ action: "future-event" }), null);
  assert.throws(() => normalizeDelivery({ action: "order-placed" }), /orderId/);
  assert.throws(() => normalizeDelivery({}), /action/);
  assert.throws(() => normalizeDelivery("bad-json"));
});

test("webhook ingest parses JSON; output fetches order with the connected organization", async () => {
  const delivery = {
    action: "order-placed",
    orderId: "order_1",
    timestamp: "2026-01-01T12:00:00Z",
  };
  const raw = {
    method: "POST",
    path: "/webhook",
    query: {},
    headers: {},
    body: JSON.stringify(delivery),
  };
  const input = { raw, params: {}, state: undefined, subscriptionId: "sub_test" };
  assert.deepEqual(trigger.handleIngest(input), [delivery]);
  assert.throws(() => trigger.handleIngest({ ...input, raw: { ...raw, method: "GET" } }), /POST/);
  const { ctx, requests } = context([{ success: true, data: order }], true);
  const out = await trigger.parseOutput({
    normalized: normalizeDelivery(delivery)!,
    call: raw,
    subscriptionId: "sub_test",
  }, ctx);
  assert.deepEqual(out, { ...delivery, order });
  assert.equal(requests[0].url, `${STAGING_API_URL}/get-order-by-id?orderId=order_1`);
});
