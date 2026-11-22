import { test } from "node:test";
import assert from "node:assert/strict";
import pagesAction from "../actions/order-import-pages.ts";
import type { ImportPageJob, ImportPagesInput, ImportPagesOutput, ImportTarget } from "../actions/order-import-pages.ts";
import flattenAction from "../actions/order-import-flatten.ts";
import type { ImportFlattenInput, ImportFlattenOutput, ImportPageResult } from "../actions/order-import-flatten.ts";
import transformOrder from "../actions/transform-order.ts";
import { readCapture } from "../../../tests/live-fixtures.ts";

const plan = (i: ImportPagesInput) => (pagesAction.execute as (i: ImportPagesInput) => ImportPagesOutput)(i);
const flatten = (i: ImportFlattenInput) => (flattenAction.execute as (i: ImportFlattenInput) => ImportFlattenOutput)(i);
const transform = (input: Record<string, unknown>) =>
  (transformOrder.execute as (i: never) => { order: Record<string, unknown>; context: { urn: string } })(input as never);

const sample = () => readCapture<{ data: { orders: Array<Record<string, unknown>> } }>("event-9-orders-page-1").body.data.orders[0]!;
const mkOrder = (n: number) => ({ ...structuredClone(sample()), _id: `65f1e00000000000000001${String(n).padStart(2, "0")}` });
const page = (ns: number[], current: number, hasMore: boolean): ImportPageResult => ({
  orders: ns.map(mkOrder),
  count: ns.length,
  pagination: { hasMore, currentPage: current, nextPage: hasMore ? current + 1 : null },
});
const empty = (current: number): ImportPageResult => ({ orders: [], count: 0, pagination: { hasMore: false, currentPage: current, nextPage: null } });
const mapped = (cohostEventId: string, fliteEventId: string): ImportTarget => ({ cohostEventId, mapped: true, fliteEventId });

test("pages: mapped events get jobs 1..maxPages, in order", () => {
  const r = plan({ targets: [mapped("e1", "9")], maxPages: 4 });
  assert.deepEqual(r.jobs, [1, 2, 3, 4].map((p): ImportPageJob => ({ cohostEventId: "e1", eventId: "9", page: p })));
  assert.deepEqual(r.skipped, []);
  assert.equal(plan({ targets: [mapped("e1", "9")] }).jobs.length, 10, "default 10 pages");
});

test("pages: unmapped targets are skipped with a reason and emit no jobs", () => {
  const r = plan({
    targets: [
      { cohostEventId: "e2", mapped: false, reason: "unmapped: nothing" },
      { cohostEventId: "e3", mapped: false },
      { cohostEventId: "e4", mapped: true }, // mapped without a Flite id is never trusted
    ],
    maxPages: 3,
  });
  assert.deepEqual(r.jobs, []);
  assert.deepEqual(r.skipped.map((s) => s.cohostEventId), ["e2", "e3", "e4"]);
  assert.equal(r.skipped[0]!.reason, "unmapped: nothing");
  for (const s of r.skipped) assert.ok(s.reason.length > 0);
  assert.deepEqual(plan({ targets: [] }), { jobs: [], skipped: [] });
});

test("pages: a Flite event reachable from two Cohost events, or a repeated Cohost event, is planned once", () => {
  const r = plan({ targets: [mapped("e1", "9"), mapped("e2", "9"), mapped("e1", "8")], maxPages: 1 });
  assert.deepEqual(r.jobs, [{ cohostEventId: "e1", eventId: "9", page: 1 }]);
  assert.deepEqual(r.skipped.map((s) => s.cohostEventId), ["e2", "e1"]);
});

test("pages: bad maxPages / targets throw", () => {
  for (const maxPages of [0, -1, 1.5, 1001, Number.NaN]) assert.throws(() => plan({ targets: [], maxPages }), /maxPages/, String(maxPages));
  assert.throws(() => plan({ targets: "x" as never }), /targets/);
  assert.throws(() => plan({ targets: [{ mapped: true, fliteEventId: "9" } as never] }), /cohostEventId/);
});

test("flatten: a 3-page fixture is fully consumed; pages past the end are ignored", () => {
  const jobs = plan({ targets: [mapped("e1", "9")], maxPages: 5 }).jobs;
  const pages = [page([1, 2], 1, true), page([3, 4], 2, true), page([5], 3, false), empty(4), empty(5)];
  const r = flatten({ jobs, pages });
  assert.equal(r.count, 5);
  assert.equal(r.items.length, 5);
  assert.equal(r.pageCount, 5);
  assert.deepEqual(r.items.map((i) => (i.order as { _id: string })._id.slice(-2)), ["01", "02", "03", "04", "05"]);
  assert.ok(r.items.every((i) => i.eventId === "9" && i.cohostEventId === "e1"));
  assert.deepEqual(r.truncated, []);
  assert.deepEqual(r.skipped, []);
});

test("flatten: still hasMore on the last fetched page => truncated (also via nextPage alone)", () => {
  const jobs = plan({ targets: [mapped("e1", "9")], maxPages: 2 }).jobs;
  const r = flatten({ jobs, pages: [page([1], 1, true), page([2], 2, true)] });
  assert.deepEqual(r.truncated, [{ cohostEventId: "e1", eventId: "9", lastPage: 2 }]);
  assert.equal(r.count, 2);
  const noFlag: ImportPageResult = { orders: [mkOrder(3)], pagination: { hasMore: false, currentPage: 1, nextPage: 2 } };
  assert.equal(flatten({ jobs: [{ cohostEventId: "e1", eventId: "9", page: 1 }], pages: [noFlag] }).truncated.length, 1);
});

test("flatten: empty first page and null pagination are fine (no orders, not truncated)", () => {
  const jobs = plan({ targets: [mapped("e1", "9")], maxPages: 2 }).jobs;
  const r = flatten({ jobs, pages: [empty(1), empty(2)] });
  assert.deepEqual([r.count, r.items, r.truncated], [0, [], []]);
  const nullPag = flatten({ jobs: [jobs[0]!], pages: [{ orders: [mkOrder(1)], pagination: null }] });
  assert.equal(nullPag.count, 1);
  assert.deepEqual(nullPag.truncated, []);
});

test("flatten: a non-advancing nextPage cannot loop or duplicate — bounded by jobs, de-duplicated by _id", () => {
  const jobs = plan({ targets: [mapped("e1", "9")], maxPages: 3 }).jobs;
  const stuck: ImportPageResult = { orders: [mkOrder(1), mkOrder(2)], pagination: { hasMore: true, currentPage: 1, nextPage: 1 } };
  const r = flatten({ jobs, pages: [stuck, structuredClone(stuck), structuredClone(stuck)] });
  assert.equal(r.items.length, 2, "same orders from repeated pages are imported once");
  assert.equal(r.pageCount, 3);
  assert.deepEqual(r.truncated, [{ cohostEventId: "e1", eventId: "9", lastPage: 3 }], "never-ending paging is reported, not swallowed");
});

test("flatten: events are independent (truncation, de-dup) and skipped passes through", () => {
  const jobs = plan({ targets: [mapped("e1", "9"), mapped("e2", "8"), { cohostEventId: "e3", mapped: false, reason: "r" }], maxPages: 2 });
  const pages = [page([1], 1, true), page([2], 2, false), page([1], 1, false), empty(2)];
  const r = flatten({ jobs: jobs.jobs, pages, skipped: jobs.skipped });
  assert.equal(r.count, 3, "same order id under another event is a different order");
  assert.deepEqual(r.truncated, []);
  assert.deepEqual(r.skipped, [{ cohostEventId: "e3", reason: "r" }]);
  assert.deepEqual(r.items.map((i) => i.cohostEventId), ["e1", "e1", "e2"]);
  assert.deepEqual(flatten({ jobs: [], pages: [] }).skipped, []);
});

test("flatten: misaligned pages, missing orders array or order id throw", () => {
  const j: ImportPageJob = { cohostEventId: "e1", eventId: "9", page: 1 };
  assert.throws(() => flatten({ jobs: [j], pages: [] }), /align/);
  assert.throws(() => flatten({ jobs: [j], pages: [{} as never] }), /orders array/);
  assert.throws(() => flatten({ jobs: [j], pages: [{ orders: [{}], pagination: null }] }), /_id/);
  assert.throws(() => flatten({ jobs: "x" as never, pages: [] }), /arrays/);
});

test("every imported order has a stable URN and deferred payment; two runs give identical URNs", () => {
  const run = () => {
    const jobs = plan({ targets: [mapped("e1", "9")], maxPages: 4 }).jobs;
    const flat = flatten({ jobs, pages: [page([1, 2], 1, true), page([3, 4], 2, true), page([5], 3, false), empty(4)] });
    return flat.items.map((it) => transform({ order: it.order, eventId: it.eventId, companyId: "company_test", env: "sandbox" }));
  };
  const a = run();
  const b = run();
  assert.equal(a.length, 5);
  assert.deepEqual(a.map((x) => x.context.urn), b.map((x) => x.context.urn));
  assert.equal(new Set(a.map((x) => x.context.urn)).size, 5, "one distinct identity per order");
  for (const { order, context } of a) {
    assert.equal(order.paymentMethod, "deferred");
    assert.match(context.urn, /^urn:1:company_test:flite-sandbox:\/orders\/65f1e00000000000000001\d\d$/);
    assert.match(String(order.contextId), /:flite-sandbox:\/events\/9$/);
  }
});
