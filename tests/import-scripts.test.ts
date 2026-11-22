import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pagesAction from "../packages/cohost-flite-transformer/actions/order-import-pages.ts";
import type { ImportPagesInput, ImportPagesOutput, ImportTarget } from "../packages/cohost-flite-transformer/actions/order-import-pages.ts";
import flattenAction from "../packages/cohost-flite-transformer/actions/order-import-flatten.ts";
import type { ImportFlattenInput, ImportFlattenOutput, ImportPageResult } from "../packages/cohost-flite-transformer/actions/order-import-flatten.ts";
import transformOrder from "../packages/cohost-flite-transformer/actions/transform-order.ts";
import { readCapture } from "./live-fixtures.ts";

type Node = { id: string; with: { code?: string; input?: Record<string, unknown> } };
const wf = JSON.parse(readFileSync("workflows/flite-sales-channel.workflow.json", "utf8")) as { nodes: Node[] };
const code = (id: string) => {
  const n = wf.nodes.find((x) => x.id === id);
  assert.ok(n?.with.code, `${id} has script code`);
  return n.with.code;
};
/** Runs shipped script code the way @w6w/script does: the code is a function body with `input` in scope. */
const script = (id: string, input: unknown) => new Function("input", code(id))(input);

const CO = "co1";
const EXPECTED = { provider: "flite", env: "sandbox", org: "o1", channelId: "ch1" };
const mapping = (fliteId: string, over: Record<string, unknown> = {}) => {
  const mappedUrn = `urn:1:${CO}:conn_f:/events/${fliteId}`;
  return { urn: mappedUrn, mappedUrn, labels: { ...EXPECTED, listingId: "l1", kind: "event", ...over } };
};
const target = (eventId: string, mappings: unknown[]) =>
  script("ev_target", { eventId, mappings, companyId: CO, expected: EXPECTED }) as ImportTarget;

const plan = (i: ImportPagesInput) => (pagesAction.execute as (i: ImportPagesInput) => ImportPagesOutput)(i);
const flatten = (i: ImportFlattenInput) => (flattenAction.execute as (i: ImportFlattenInput) => ImportFlattenOutput)(i);
const transform = (input: Record<string, unknown>) =>
  (transformOrder.execute as (i: never) => { order: Record<string, unknown>; context: { urn: string } })(input as never);

const sample = () => readCapture<{ data: { orders: Array<Record<string, unknown>> } }>("event-9-orders-page-1").body.data.orders[0]!;
const mkOrder = (n: number) => ({ ...structuredClone(sample()), _id: `65f1e00000000000000002${String(n).padStart(2, "0")}` });
const pg = (ns: number[], cur: number, more: boolean): ImportPageResult => ({
  orders: ns.map(mkOrder),
  pagination: { hasMore: more, currentPage: cur, nextPage: more ? cur + 1 : null },
});
/** Stands in for the Flite page foreach: serves `pages[page-1]` per job, an empty page past the end. */
const serve = (byEvent: Record<string, ImportPageResult[]>) => (jobs: Array<{ eventId: string; page: number }>) =>
  jobs.map((j) => byEvent[j.eventId]?.[j.page - 1] ?? { orders: [], pagination: { hasMore: false, currentPage: j.page, nextPage: null } });

/** The whole import root, end to end, over the shipped scripts and actions; `upserts` is what import_each_order would write. */
function runImport(cohostEvents: Array<[string, unknown[]]>, flite: Record<string, ImportPageResult[]>, maxPages = 5) {
  const targets = cohostEvents.map(([id, ms]) => target(id, ms));
  const planned = plan({ targets, maxPages });
  const flat = flatten({ jobs: planned.jobs, pages: serve(flite)(planned.jobs), skipped: planned.skipped });
  script("import_complete", { truncated: flat.truncated, skipped: flat.skipped, count: flat.count });
  const upserts = flat.items.map((it) => transform({ order: it.order, eventId: it.eventId, companyId: CO, connectionId: "conn_f" }));
  return { planned, flat, upserts };
}
const THREE = { "9": [pg([1, 2], 1, true), pg([3, 4], 2, true), pg([5], 3, false)] };

test("ev_target: a mapping registered by this channel is mapped to its Flite event", () => {
  assert.deepEqual(target("evt_1", [mapping("9")]), { cohostEventId: "evt_1", mapped: true, fliteEventId: "9" });
});

test("ev_target: unmapped / foreign-labelled / malformed mappings are skipped with a reason", () => {
  const cases: Array<[string, unknown[], RegExp]> = [
    ["no mappings", [], /unmapped/],
    ["mappings not an array", undefined as never, /unmapped/],
    ["other channel", [mapping("9", { channelId: "ch2" })], /unmapped/],
    ["other env label", [mapping("9", { env: "production" })], /unmapped/],
    ["other org", [mapping("9", { org: "o2" })], /unmapped/],
    ["other provider", [mapping("9", { provider: "eventbrite" })], /unmapped/],
    ["label dropped", [mapping("9", { channelId: undefined })], /unmapped/],
    ["empty source segment in the URN", [{ ...mapping("9"), urn: `urn:1:${CO}::/events/9`, mappedUrn: undefined }], /unmapped/],
    ["foreign company in the URN", [{ ...mapping("9"), urn: `urn:1:other:conn_f:/events/9`, mappedUrn: undefined }], /unmapped/],
    ["not an event URN", [{ ...mapping("9"), urn: `urn:1:${CO}:conn_f:/events/9/tickets/1`, mappedUrn: undefined }], /unmapped/],
    ["ambiguous", [mapping("9"), mapping("8")], /ambiguous/],
  ];
  for (const [name, ms, reason] of cases) {
    const t = target("evt_1", ms);
    assert.equal(t.mapped, false, name);
    assert.equal(t.fliteEventId, undefined, name);
    assert.match(String(t.reason), reason, name);
  }
  assert.equal(script("ev_target", { eventId: "e", mappings: [mapping("9")], companyId: CO, expected: {} }).mapped, false, "no expected labels never maps");
  assert.equal(script("ev_target", { eventId: "e", mappings: [mapping("9")], companyId: CO, expected: { ...EXPECTED, org: "" } }).mapped, false, "empty expected label never maps");
});

test("unmapped / foreign-channel event: skipped visibly, zero page jobs, zero orders, zero upserts", () => {
  const r = runImport([["evt_x", []], ["evt_y", [mapping("9", { channelId: "ch2" })]]], THREE);
  assert.deepEqual(r.planned.jobs, []);
  assert.deepEqual(r.planned.skipped.map((s) => s.cohostEventId), ["evt_x", "evt_y"]);
  assert.ok(r.planned.skipped.every((s) => s.reason.length > 0));
  assert.equal(r.flat.count, 0);
  assert.deepEqual(r.upserts, []);
  assert.equal(r.flat.skipped.length, 2, "skips survive to import_complete");
});

test("mixed channel: only the mapped event is imported, the foreign one is skipped", () => {
  const r = runImport([["evt_1", [mapping("9")]], ["evt_2", [mapping("7", { channelId: "ch2" })]]], { ...THREE, "7": [pg([9], 1, false)] });
  assert.equal(r.upserts.length, 5);
  assert.ok(r.flat.items.every((i) => i.cohostEventId === "evt_1" && i.eventId === "9"));
  assert.deepEqual(r.flat.skipped.map((s) => s.cohostEventId), ["evt_2"]);
});

test("3-page event: all pages consumed, every order has a stable URN and deferred paymentMethod", () => {
  const r = runImport([["evt_1", [mapping("9")]]], THREE);
  assert.equal(r.flat.count, 5);
  assert.equal(r.upserts.length, 5);
  for (const u of r.upserts) {
    assert.equal(u.order.paymentMethod, "deferred");
    assert.match(u.context.urn, new RegExp(`^urn:1:${CO}:conn_f:/orders/65f1e00000000000000002\\d\\d$`));
  }
});

test("re-run: identical upsert keys (order.urn in the upsert-order payload), no new identities", () => {
  const first = runImport([["evt_1", [mapping("9")]]], THREE).upserts;
  const second = runImport([["evt_1", [mapping("9")]]], structuredClone(THREE)).upserts;
  const key = (u: { order: Record<string, unknown> }) => u.order.urn as string;
  const a = first.map(key);
  const b = second.map(key);
  assert.equal(a.length, 5);
  for (const k of a) assert.match(k, new RegExp(`^urn:1:${CO}:conn_f:/orders/65f1e00000000000000002\\d\\d$`));
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
  assert.deepEqual(a, first.map((u) => u.context.urn), "payload key equals the context urn");
});

test("empty first page: nothing to import and no failure", () => {
  const r = runImport([["evt_1", [mapping("9")]]], { "9": [pg([], 1, false)] });
  assert.deepEqual([r.flat.count, r.upserts.length], [0, 0]);
});

test("import_complete refuses (before any upsert) when the page cap cut an event off", () => {
  assert.throws(() => runImport([["evt_1", [mapping("9")]]], THREE, 2), /truncated.*nothing imported/);
});

test("import_event_ids: explicit id wins, else every channel event; an incomplete listing throws", () => {
  assert.deepEqual(script("import_event_ids", { eventId: "evt_9", results: [{ id: "a" }], total: 1 }), { eventIds: ["evt_9"] });
  assert.deepEqual(script("import_event_ids", { eventId: "", results: [{ id: "a" }, { id: "b" }], total: 2 }), { eventIds: ["a", "b"] });
  assert.deepEqual(script("import_event_ids", { eventId: "", results: [], total: 0 }), { eventIds: [] });
  assert.throws(() => script("import_event_ids", { eventId: "", results: [{ id: "a" }], total: 3 }), /import not started/);
});

test("ev_target matches any source segment (the Flite connection id), not a pseudo flite-<env> id", () => {
  const t = target("evt_1", [{ ...mapping("9"), urn: `urn:1:${CO}:conn_zzz:/events/9`, mappedUrn: undefined }]);
  assert.equal(t.mapped, true);
  assert.equal(t.fliteEventId, "9");
});
