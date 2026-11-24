import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildDesiredState, type ChannelSnapshot } from "../lib/channel-sync.ts";
import { canonicalJson, digestOf } from "../lib/digest.ts";
import { sha256Hex } from "../lib/sha256.ts";

test("sha256: known vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  assert.equal(sha256Hex("a".repeat(1_000_000)), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("sha256: matches node:crypto across padding boundaries and non-ASCII text", () => {
  for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
    const text = "x".repeat(n);
    assert.equal(sha256Hex(text), createHash("sha256").update(text).digest("hex"), String(n));
  }
  for (const text of ["café — “quotes” ☕", "emoji 🎟️ ticket", "日本語"]) {
    assert.equal(sha256Hex(text), createHash("sha256").update(text, "utf8").digest("hex"), text);
  }
});

test("canonicalJson sorts keys at every depth and drops undefined members", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[{"y":2,"z":1}]},"b":1}');
  assert.equal(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }));
  assert.match(digestOf({}), /^v1:[0-9a-f]{64}$/);
});

const URN = "urn:1:co:cohost-falcon:/events/ev1";
function snap(over: Record<string, unknown> = {}): ChannelSnapshot {
  return {
    channelId: "ch1",
    eventId: "ev1",
    companyId: "co",
    eventUrn: URN,
    listing: { id: "L1" },
    visibility: "visible",
    shown: true,
    channelEvent: { name: "Channel Name", salesEnabled: true, contentBlocks: [] },
    channelTickets: [
      { id: "t2", name: "VIP", status: "live", priceCategory: "paid", costs: { cost: "USD,5000" }, description: "v" },
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
      created: "2026-01-01T00:00:00Z",
      changed: "2026-01-02T00:00:00Z",
    },
    tickets: [
      { id: "t1", capacity: 100, quantitySold: 30, status: "live" },
      { id: "t2", capacity: 10, quantitySold: 0, status: "live" },
    ],
    mappings: { event: [], tickets: {} },
    ...over,
  } as unknown as ChannelSnapshot;
}
const digest = (over: Record<string, unknown> = {}) => buildDesiredState(snap(over)).digest;
const ownerEvent = (over: Record<string, unknown>) => ({ event: { ...snap().event, ...over } });
const withTicket = (id: string, over: Record<string, unknown>) =>
  ({ channelTickets: snap().channelTickets.map((t) => (t.id === id ? { ...t, ...over } : t)) });

test("digest: v1 + sha256 hex, stable across calls", () => {
  assert.match(digest(), /^v1:[0-9a-f]{64}$/);
  assert.equal(digest(), digest());
});

test("digest: independent of ticket order and of object key order", () => {
  const s = snap();
  const reversed = snap({ channelTickets: [...s.channelTickets].reverse(), tickets: [...s.tickets].reverse() });
  assert.equal(buildDesiredState(reversed).digest, buildDesiredState(s).digest);
  const reorder = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).reverse());
  const shuffled = snap({
    channelTickets: s.channelTickets.map(reorder),
    channelEvent: reorder(s.channelEvent!),
    event: reorder(s.event),
  });
  assert.equal(buildDesiredState(shuffled).digest, buildDesiredState(s).digest);
});

test("digest: independent of created/changed timestamps, mappings and errors", () => {
  const base = digest();
  assert.equal(digest(ownerEvent({ created: "2030-01-01T00:00:00Z", changed: "2030-06-01T00:00:00Z" })), base);
  assert.equal(digest({ mappings: { event: [{ mappedUrn: "m", labels: { id: "x", digest: "v1:old" } }], tickets: {} } }), base);
});

test("digest changes with price, availability, capacity, event field, listingId, mode and flyer", () => {
  const base = digest();
  const changed = {
    price: digest(withTicket("t1", { costs: { cost: "USD,2600" } })),
    availability: digest(withTicket("t1", { status: "hidden" })),
    capacity: digest({ tickets: [{ id: "t1", capacity: 90, quantitySold: 30, status: "live" }, { id: "t2", capacity: 10, quantitySold: 0, status: "live" }] }),
    name: digest({ channelEvent: { name: "Other", salesEnabled: true, contentBlocks: [] } }),
    start: digest(ownerEvent({ start: "2027-04-11T02:00:00.000Z" })),
    listingId: digest({ listing: { id: "L2" } }),
    mode: digest({ ...ownerEvent({ status: "started" }), shown: false }),
    flyer: digest({ channelEvent: { name: "Channel Name", salesEnabled: true, contentBlocks: [], flyer: { url: "https://x.test/f.jpg" } } }),
  };
  const all = [base, ...Object.values(changed)];
  assert.equal(new Set(all).size, all.length, JSON.stringify({ base, ...changed }));
});

test("digest: the mode matters even for the same event content", () => {
  const publish = buildDesiredState(snap());
  const stop = buildDesiredState(snap({ shown: false, mappings: { event: [{ mappedUrn: "m" }], tickets: {} } }));
  assert.equal(publish.mode, "publish");
  assert.equal(stop.mode, "stop");
  assert.notEqual(publish.digest, stop.digest);
});
