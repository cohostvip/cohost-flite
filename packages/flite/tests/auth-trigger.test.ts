import { test } from "node:test";
import assert from "node:assert/strict";
import { production, staging } from "../auth/bearer-token.ts";
import trigger, { normalizeDelivery } from "../triggers/order-placed.ts";
import { fliteSignature, verifyFliteDelivery } from "../lib/webhook.ts";
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
    // A non-Flite host (a flyer download) goes out unsigned: no token, and a caller's own
    // authorization header is dropped too.
    const foreign = await auth.sign!({
      credential: { token: "test-token" },
      request: { url: "https://evil.example.test/api/get-order-by-id", method: "GET", headers: { Authorization: "Bearer x" } },
    }, ctx);
    assert.deepEqual(foreign.headers, {});
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

const SECRET = "fsec_live_test_secret_0123456789abcdef";

// The documented Flite Partner Webhook body (docs/api-docs.md, "Webhooks — Verification").
const documented = {
  webhookEventId: "evt_flite_01J3Kxxxxxxxxxx",
  eventType: "order.completed",
  orderId: "7f3a1b2c4d5e6f7a8b9c0d1e",
  organizationId: "6849f3a2c1d4e5f6a7b8c9d0",
  eventId: "6850a4b3d2e5f6a7b8c9d0e1",
  created: "2026-07-18T00:00:00.000Z",
};

/** A delivery signed the way Flite signs it, with the given body text and timestamp. */
async function signedCall(rawBody: string, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const ts = String(timestamp);
  return {
    method: "POST",
    path: "/webhook",
    query: {},
    headers: {
      "content-type": "application/json",
      "x-flite-signature": await fliteSignature(secret, ts, rawBody),
      "x-flite-timestamp": ts,
    } as Record<string, string>,
    body: JSON.parse(rawBody),
    rawBody,
  };
}

function ingest(raw: Awaited<ReturnType<typeof signedCall>>, params: { signingSecret?: string } = { signingSecret: SECRET }) {
  return trigger.handleIngest({ raw, params, state: undefined, subscriptionId: "sub_test" });
}

test("signing formula matches Flite's documented Node.js example", async () => {
  const { createHmac } = await import("node:crypto");
  const body = JSON.stringify(documented);
  const expected = "sha256=" + createHmac("sha256", SECRET).update(`1750000000.${body}`).digest("hex");
  assert.equal(await fliteSignature(SECRET, "1750000000", body), expected);
});

test("a signed delivery in the documented format emits one order event", async () => {
  const events = await ingest(await signedCall(JSON.stringify(documented)));
  assert.deepEqual(events, [documented]);
});

test("a pretty-printed signed body verifies against its compact form too", async () => {
  // Flite signs JSON.stringify(payload); a body sent with whitespace still verifies.
  const raw = await signedCall(JSON.stringify(documented));
  raw.rawBody = JSON.stringify(documented, null, 2);
  assert.deepEqual(await ingest(raw), [documented]);
});

test("every delivery that does not verify is refused", async () => {
  const body = JSON.stringify(documented);
  // Unset secret refuses even a correctly signed body.
  await assert.rejects(ingest(await signedCall(body), {}), /signing secret is not set/);
  await assert.rejects(ingest(await signedCall(body), { signingSecret: "" }), /signing secret is not set/);
  // Wrong secret.
  await assert.rejects(ingest(await signedCall(body, { secret: "fsec_live_other" })), /does not match/);
  // Tampered body (signature over the original).
  const tampered = await signedCall(body);
  tampered.rawBody = JSON.stringify({ ...documented, orderId: "someone_elses_order" });
  await assert.rejects(ingest(tampered), /does not match/);
  // Replay outside the five-minute window, both directions.
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(ingest(await signedCall(body, { timestamp: now - 301 })), /five-minute window/);
  await assert.rejects(ingest(await signedCall(body, { timestamp: now + 301 })), /five-minute window/);
  // Timestamp swapped after signing.
  const swapped = await signedCall(body);
  swapped.headers["x-flite-timestamp"] = String(now - 1);
  await assert.rejects(ingest(swapped), /does not match/);
  // Missing headers, raw body, non-JSON, non-POST.
  const noSig = await signedCall(body);
  delete noSig.headers["x-flite-signature"];
  await assert.rejects(ingest(noSig), /X-Flite-Signature is missing/);
  const noTs = await signedCall(body);
  delete noTs.headers["x-flite-timestamp"];
  await assert.rejects(ingest(noTs), /X-Flite-Timestamp is missing/);
  const noRaw = await signedCall(body);
  delete (noRaw as { rawBody?: string }).rawBody;
  await assert.rejects(ingest(noRaw), /raw body is unavailable/);
  await assert.rejects(
    verifyFliteDelivery({ headers: { "x-flite-signature": "sha256=00", "x-flite-timestamp": String(now) }, rawBody: "not json" }, SECRET),
    /not JSON/,
  );
  await assert.rejects(ingest({ ...(await signedCall(body)), method: "GET" }), /POST/);
});

test("header names are matched case-insensitively", async () => {
  const raw = await signedCall(JSON.stringify(documented));
  const { "x-flite-signature": sig, "x-flite-timestamp": ts, ...rest } = raw.headers;
  raw.headers = { ...rest, "X-Flite-Signature": sig, "X-Flite-Timestamp": ts };
  assert.deepEqual(await ingest(raw), [documented]);
});

test("pending checkouts and unknown events are acknowledged without a run", async () => {
  assert.deepEqual(await ingest(await signedCall(JSON.stringify({ ...documented, eventType: "order.created" }))), []);
  assert.deepEqual(await ingest(await signedCall(JSON.stringify({ ...documented, eventType: "order.future" }))), []);
  for (const eventType of ["order.refunded", "order.updated", "order.disputed", "order.scan"]) {
    assert.deepEqual(await ingest(await signedCall(JSON.stringify({ ...documented, eventType }))), [
      { ...documented, eventType },
    ]);
  }
});

test("normalizer rejects bodies that are not Flite order notifications", () => {
  assert.throws(() => normalizeDelivery({}), /eventType/);
  assert.throws(() => normalizeDelivery({ action: "order-placed", orderId: "order_1" }), /eventType/);
  assert.throws(() => normalizeDelivery({ ...documented, orderId: "" }), /orderId/);
  assert.throws(() => normalizeDelivery({ ...documented, webhookEventId: undefined }), /webhookEventId/);
  assert.throws(() => normalizeDelivery("bad-json"));
  assert.deepEqual(normalizeDelivery({ ...documented, organizationId: undefined, eventId: undefined }), {
    ...documented,
    organizationId: null,
    eventId: null,
  });
});

test("trigger declares a manual webhook with a required secret signing param", () => {
  assert.equal(trigger.webhook.registration, "manual");
  assert.match(trigger.webhook.instructions!, /signing secret/i);
  assert.deepEqual(trigger.params.map((p) => [p.key, p.type, p.required]), [["signingSecret", "secret", true]]);
});

test("output fetches the order by the notification's orderId with the connected organization", async () => {
  const { ctx, requests } = context([{ success: true, data: order }], true);
  const raw = await signedCall(JSON.stringify(documented));
  const out = await trigger.parseOutput({ normalized: normalizeDelivery(documented)!, call: raw, subscriptionId: "sub_test" }, ctx);
  assert.deepEqual(out, { ...documented, order });
  assert.equal(requests[0].url, `${STAGING_API_URL}/get-order-by-id?orderId=${documented.orderId}`);
});
