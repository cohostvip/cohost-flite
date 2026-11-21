import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseEventMapping,
  chooseTicketMapping,
  type DesiredState,
  guardEnv,
  mappedUrn,
  planMappings,
  registration,
  relabelRegistrations,
} from "../lib/sync.ts";
import { context } from "../../../tests/fixtures.ts";

const labels = { provider: "flite", env: "sandbox", org: "org_1", channelId: "ch_1", listingId: "L2" };

function desired(over: Partial<DesiredState> = {}): DesiredState {
  return {
    mode: "publish",
    companyId: "co_1",
    channelId: "ch_1",
    listingId: "L2",
    eventId: "ev_1",
    eventUrn: "urn:1:co_1:cohost-falcon:/events/ev_1",
    labels,
    event: null,
    tickets: [{ ticketId: "t1", ticketUrn: "urn:1:co_1:cohost-falcon:/events/ev_1/tickets/t1", fields: {}, availability: "true" }],
    mappings: { event: [], tickets: {} },
    errors: [],
    ...over,
  };
}
const rec = (id: string, extra: Record<string, string> = {}) => ({ labels: { id, eventId: id, listingId: "L1", ...extra } });

test("env guard: sandbox iff staging; mismatch with expectedEnv or labels throws", () => {
  const staging = context([], true).ctx;
  const prod = context([], false).ctx;
  assert.equal(guardEnv(staging, "sandbox", desired()), "sandbox");
  assert.equal(guardEnv(prod, "production", desired({ labels: { ...labels, env: "production" } })), "production");
  assert.throws(() => guardEnv(staging, "production", desired()), /sandbox but the workflow expects production/);
  assert.throws(() => guardEnv(prod, "sandbox", desired()), /production/);
  assert.throws(() => guardEnv(staging, "sandbox", desired({ labels: { ...labels, env: "production" } })), /sandbox/);
  assert.throws(() => guardEnv(staging, "bogus", desired()), /expectedEnv/);
});

test("mapped URN format", () => {
  assert.equal(mappedUrn("co", "sandbox", "e1"), "urn:1:co:flite-sandbox:/events/e1");
  assert.equal(mappedUrn("co", "production", "e1", "t1"), "urn:1:co:flite-production:/events/e1/tickets/t1");
});

test("event dedupe: none ⇒ create, one ⇒ use, many ⇒ smallest id + warning; listingId never selects", () => {
  assert.equal(chooseEventMapping([]).id, undefined);
  assert.equal(chooseEventMapping(undefined).id, undefined);
  assert.deepEqual(chooseEventMapping([rec("b")]), { id: "b", storedListingId: "L1", warnings: [] });
  const many = chooseEventMapping([rec("c"), { labels: { id: "a", eventId: "a", listingId: "L2" } }, rec("b")]);
  assert.equal(many.id, "a");
  assert.equal(many.warnings.length, 1);
  assert.match(many.warnings[0], /smallest id a/);
  // a mapping without labels.id is ignored (ids come from labels only, not mappedUrn)
  assert.equal(chooseEventMapping([{ mappedUrn: "urn:1:co:flite-sandbox:/events/zzz" }]).id, undefined);
});

test("ticket mapping honoured only when labels.eventId matches the chosen event", () => {
  const records = [
    { labels: { id: "t_a", eventId: "OTHER", listingId: "L1" } },
    { labels: { id: "t_z", eventId: "e1", listingId: "L1" } },
    { labels: { id: "t_m", eventId: "e1", listingId: "L1" } },
  ];
  const c = chooseTicketMapping(records, "e1");
  assert.equal(c.id, "t_m");
  assert.equal(c.warnings.length, 1);
  assert.equal(chooseTicketMapping([records[0]], "e1").id, undefined);
});

test("planMappings: unmapped event ⇒ no ids; mapped event + unmapped ticket ⇒ ticket create", () => {
  const none = planMappings(desired());
  assert.equal(none.fliteEventId, undefined);
  assert.equal(none.tickets[0].fliteTicketId, undefined);
  const plan = planMappings(desired({ mappings: { event: [rec("e1")], tickets: { t1: [{ labels: { id: "x", eventId: "other" } }] } } }));
  assert.equal(plan.fliteEventId, "e1");
  assert.equal(plan.tickets[0].fliteTicketId, undefined);
});

test("registration carries mappedUrn and every label", () => {
  const d = desired();
  assert.deepEqual(registration(d, "sandbox", "e1"), {
    urn: d.eventUrn,
    mappedUrn: "urn:1:co_1:flite-sandbox:/events/e1",
    labels: { provider: "flite", env: "sandbox", org: "org_1", channelId: "ch_1", listingId: "L2", kind: "event", id: "e1", eventId: "e1" },
  });
  const t = registration(d, "sandbox", "e1", { ticketUrn: d.tickets[0].ticketUrn, fliteTicketId: "ft1" });
  assert.equal(t.urn, d.tickets[0].ticketUrn);
  assert.equal(t.mappedUrn, "urn:1:co_1:flite-sandbox:/events/e1/tickets/ft1");
  assert.deepEqual(t.labels, { ...t.labels, kind: "ticket", id: "ft1", eventId: "e1", listingId: "L2" });
});

test("relabel only when stored listingId differs from desired", () => {
  const same = desired({
    labels: { ...labels, listingId: "L1" },
    mappings: { event: [rec("e1")], tickets: { t1: [rec("ft1", { eventId: "e1" })] } },
  });
  assert.deepEqual(relabelRegistrations(same, "sandbox", planMappings(same)), []);
  const diff = desired({ mappings: { event: [rec("e1")], tickets: { t1: [rec("ft1", { eventId: "e1" })] } } });
  const out = relabelRegistrations(diff, "sandbox", planMappings(diff));
  assert.deepEqual(out.map((r) => r.mappedUrn), [
    "urn:1:co_1:flite-sandbox:/events/e1",
    "urn:1:co_1:flite-sandbox:/events/e1/tickets/ft1",
  ]);
  assert.ok(out.every((r) => r.labels.listingId === "L2"));
  assert.deepEqual(relabelRegistrations(desired(), "sandbox", planMappings(desired())), []);
});
