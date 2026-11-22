import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bindChannelTriggers, main, validateWorkflow } from "../scripts/workflow.ts";

const FILE = "workflows/flite-sales-channel.workflow.json";
const load = () => JSON.parse(readFileSync(FILE, "utf8"));
const node = (wf: any, id: string) => wf.nodes.find((n: any) => n.id === id);

test("shipped workflow is valid", async () => {
  assert.deepEqual(await validateWorkflow(load()), []);
});

test("CLI validate exits 0 on the file and 1 on a missing one", () => {
  assert.equal(spawnSync("node", ["scripts/workflow.ts", "validate", FILE]).status, 0);
  assert.equal(spawnSync("node", ["scripts/workflow.ts", "validate", "nope.json"]).status, 1);
});

const mutations: Array<[string, (wf: any) => void, RegExp]> = [
  ["remove a trigger", (wf) => {
    wf.nodes = wf.nodes.filter((n: any) => n.id !== "channel_ticket_changed");
    wf.edges = wf.edges.filter((e: any) => e.from !== "channel_ticket_changed");
  }, /two trigger nodes/],
  ["old ticket-changed key rejected", (wf) => { node(wf, "channel_ticket_changed").uses.action = "ticket-changed"; }, /unknown trigger|two trigger nodes/],
  ["ticket trigger without channelId", (wf) => { delete node(wf, "channel_ticket_changed").with.channelId; }, /channel_ticket_changed must carry a channelId/],
  ["event trigger without channelId", (wf) => { delete node(wf, "channel_changed").with.channelId; }, /channel_changed must carry a channelId/],
  ["dangling edge", (wf) => wf.edges.push({ from: "sync", to: "ghost" }), /unknown node ghost/],
  ["renamed A key", (wf) => { node(wf, "register").uses.action = "register-urn-mapping"; }, /unknown vip\.cohost\.w6w action/],
  ["register retry < 3", (wf) => { node(wf, "register").retry.maxAttempts = 2; }, /maxAttempts >= 3/],
  ["fail step before register", (wf) => {
    wf.edges = wf.edges.filter((e: any) => !(e.from === "sync" && e.to === "register") && !(e.from === "register" && e.to === "report"));
    wf.edges.push({ from: "sync", to: "report" }, { from: "report", to: "register" });
  }, /terminal step|missing edge/],
  ["unknown F action", (wf) => { node(wf, "sync").uses.action = "sync-events"; }, /not in flite index/],
  ["listingId in mappingLabels", (wf) => { node(wf, "snapshot").with.mappingLabels.listingId = "x"; }, /mappingLabels/],
  ["mappingLabels.env not bound to vars.env", (wf) => { node(wf, "snapshot").with.mappingLabels.env = "sandbox"; }, /mappingLabels\.env/],
  ["mappingLabels.env bound to another var", (wf) => { node(wf, "snapshot").with.mappingLabels.env = { $: "vars.org" }; }, /mappingLabels\.env/],
  ["expectedEnv not bound to vars.env", (wf) => { node(wf, "sync").with.expectedEnv = { $: "vars.org" }; }, /expectedEnv/],
  ["expectedEnv literal", (wf) => { node(wf, "sync").with.expectedEnv = "production"; }, /expectedEnv/],
  ["snapshot input missing on transformer", (wf) => { delete node(wf, "desired").with.snapshot; }, /snapshot must be bound/],
  ["report code does not throw", (wf) => { node(wf, "report").with.code = "return { ok: true };"; }, /must throw when errors/],
  ["report throws unconditionally", (wf) => { node(wf, "report").with.code = "throw new Error('x');"; }, /must throw when errors/],
  ["report reachable around register", (wf) => { wf.edges.push({ from: "sync", to: "report" }); }, /without passing register|must not be reachable directly/],
  ["id outside server grammar", (wf) => { wf.id = "wf_flite_sales_channel"; }, /id must match/],
  ["key with underscore", (wf) => { wf.key = "flite_sales_channel"; }, /key must be an account slug/],
  ["embedded connection id", (wf) => { node(wf, "sync").uses.connection = "conn_1"; }, /embeds a connection id/],
];
for (const [name, mutate, re] of mutations) {
  test(`mutation rejected: ${name}`, async () => {
    const wf = load();
    mutate(wf);
    const errs = await validateWorkflow(wf);
    assert.ok(errs.some((e) => re.test(e)), `expected ${re}, got ${JSON.stringify(errs)}`);
  });
}

test("--token is rejected and install dry-run sends nothing", () => {
  const bad = spawnSync("node", ["scripts/workflow.ts", "install", FILE, "--token", "x"]);
  assert.equal(bad.status, 1);
  assert.match(String(bad.stderr), /--token is rejected/);
  const dry = spawnSync("node", ["scripts/workflow.ts", "install", FILE, "--w6w", "http://127.0.0.1:1", "--project", "p", "--token-file", "/dev/null"]);
  assert.equal(dry.status, 0);
  assert.match(String(dry.stdout), /^POST http:\/\/127\.0\.0\.1:1\/workflows\?project=p\n$/);
  assert.match(String(dry.stderr), /dry run/);
});

const run = (...a: string[]) => spawnSync("node", ["scripts/workflow.ts", ...a]);

test("missing --w6w / --token-file is refused; --project is optional", () => {
  const full = ["--w6w", "http://127.0.0.1:9", "--token-file", "/dev/null"];
  assert.equal(run("install", FILE, ...full).status, 0, "install without --project is a valid dry run");
  for (const drop of ["--w6w", "--token-file"]) {
    const i = full.indexOf(drop);
    const args = full.filter((_, j) => j !== i && j !== i + 1);
    for (const cmd of ["install", "publish", "status"]) {
      const r = run(cmd, FILE, ...args);
      assert.notEqual(r.status, 0, `${cmd} without ${drop}`);
      assert.match(String(r.stderr), /needs --w6w/);
    }
  }
});

const mkIo = () => {
  const o = { calls: [] as Array<{ url: string; init: any }>, out: [] as string[], err: [] as string[] };
  const io = {
    fetch: (async (url: any, init: any) => { o.calls.push({ url: String(url), init }); return new Response("{}", { status: 200 }); }) as typeof fetch,
    out: (s: string) => o.out.push(s),
    err: (s: string) => o.err.push(s),
  };
  return { o, io };
};

test("--token and --token=x are rejected nonzero with no request", async () => {
  for (const args of [["--token", "sekret"], ["--token=sekret"]]) {
    const { o, io } = mkIo();
    const code = await main(["install", FILE, ...args, "--w6w", "http://h", "--project", "p", "--apply"], io);
    assert.notEqual(code, 0);
    assert.deepEqual(o.calls, []);
    assert.ok(![...o.out, ...o.err].join("\n").includes("sekret"));
  }
});

test("dry run makes no request; --apply sends once with bearer from file; output is method+path only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  const tf = join(dir, "tok");
  writeFileSync(tf, "s3cr3t-token\n");
  const base = ["--w6w", "http://h", "--project", "p", "--token-file", tf];
  for (const cmd of ["install", "publish"]) {
    const { o, io } = mkIo();
    assert.equal(await main([cmd, FILE, ...base, "--var", "env=sandbox"], io), 0);
    assert.equal(o.calls.length, 0, "no request without --apply");
    assert.equal(o.out.length, 1);
    assert.equal(o.out[0], cmd === "install" ? "POST http://h/workflows?project=p" : "POST http://h/workflows/wf_flite-sales-channel/publish");
  }
  const inst = mkIo();
  assert.equal(await main(["install", FILE, ...base, "--var", "env=sandbox", "--connection", "cohost=conn_c", "--connection", "flite=conn_f", "--apply"], inst.io), 0);
  const sent = JSON.parse(inst.o.calls[0].init.body);
  assert.equal(sent.id, "wf_flite-sales-channel");
  assert.equal(sent.connections.cohost.connection, "conn_c");
  assert.equal(sent.connections.flite.connection, "conn_f");
  assert.equal(sent.variables.find((v: any) => v.key === "env").default, "sandbox");
  const { o, io } = mkIo();
  assert.equal(await main(["publish", FILE, ...base, "--apply"], io), 0);
  assert.equal(o.calls.length, 1);
  assert.equal(o.calls[0].init.method, "POST");
  assert.match(o.calls[0].url, /^http:\/\/h\/workflows\/wf_flite-sales-channel\/publish$/);
  assert.equal(o.calls[0].init.headers.authorization, "Bearer s3cr3t-token");
  assert.equal(o.out.length, 1, "stdout is exactly one method+path line");
  assert.match(o.out[0], /^POST \S+$/);
  assert.ok(![...o.out, ...o.err].join("\n").includes("s3cr3t-token"));
  const st = mkIo();
  assert.equal(await main(["status", ...base], st.io), 0);
  assert.deepEqual(st.o.out, [
    "GET http://h/workflows/wf_flite-sales-channel",
    "GET http://h/workflows/wf_flite-sales-channel/subscriptions",
    "GET http://h/workflows/wf_flite-sales-channel/runs",
  ]);
  assert.equal(st.o.calls.length, 3);
  assert.ok(st.o.calls.every((c) => c.init.method === "GET"));
});

test("no process.env in the script and no credentials in the JSON", () => {
  assert.ok(!/process\.env/.test(readFileSync("scripts/workflow.ts", "utf8").replace(/^\/\/.*$/gm, "")));
  assert.ok(!/(bearer|secret|token"\s*:|apiKey|password)/i.test(readFileSync(FILE, "utf8")));
});

test("workflow has the two channel-scoped roots plus the Flite order root, and no ticket-changed key", () => {
  const wf = load();
  const all = wf.nodes.filter((n: any) => n.uses.trigger === true);
  assert.deepEqual(all.map((n: any) => [n.id, n.uses.app, n.uses.action]).sort(), [
    ["channel_changed", "vip.cohost.w6w", "channel-event-changed"],
    ["channel_ticket_changed", "vip.cohost.w6w", "channel-ticket-changed"],
    ["order_placed", "vip.cohost.flite", "order-placed"],
  ]);
  const t = all.filter((n: any) => n.id !== "order_placed");
  for (const n of t) assert.deepEqual(n.with.channelId, { $: "vars.channelId" });
  assert.deepEqual(node(wf, "channel_ticket_changed").with.actions, ["created", "updated", "deleted"]);
  assert.deepEqual(wf.edges.filter((e: any) => e.from === "channel_ticket_changed"), [{ from: "channel_ticket_changed", to: "race" }]);
  assert.ok(!/ticket[-_]changed/.test(readFileSync(FILE, "utf8").replace(/channel[-_]ticket[-_]changed/g, "")));
});

test("install --apply with --var channelId binds the literal on BOTH trigger nodes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  const tf = join(dir, "tok");
  writeFileSync(tf, "t\n");
  const { o, io } = mkIo();
  assert.equal(await main(["install", FILE, "--w6w", "http://h", "--token-file", tf, "--var", "env=sandbox", "--var", "channelId=ch_X", "--apply"], io), 0);
  const sent = JSON.parse(o.calls[0].init.body);
  for (const id of ["channel_changed", "channel_ticket_changed"]) assert.equal(node(sent, id).with.channelId, "ch_X");
  const src = load();
  bindChannelTriggers(src, "ch_Y");
  assert.equal(node(src, "channel_ticket_changed").with.channelId, "ch_Y");
});

// Minimal resolver for {"$": "a.b.c"} refs, enough to prove which payload path each ref reads.
const resolve = (v: any, ctx: any): any => {
  if (v && typeof v === "object" && typeof v.$ === "string") return v.$.split(".").reduce((a: any, k: string) => a?.[k], ctx);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, ctx)]));
  return v;
};

test("snapshot expressions resolve channelId/eventId/companyId for both roots", () => {
  const w = node(load(), "snapshot").with;
  assert.equal(w.eventId.$, "steps.race.output.meta.eventId");
  assert.equal(w.companyId.$, "steps.race.output.meta.companyId");
  assert.equal(w.channelId.$, "vars.channelId");
  assert.equal(w.mappingLabels.channelId.$, "vars.channelId");
  for (const root of ["channel_changed", "channel_ticket_changed"]) {
    const payload = { meta: { channelId: "ch1", eventId: `ev_${root}`, companyId: "co1" } };
    const r = resolve(w, { vars: { channelId: "ch1", env: "sandbox", org: "o" }, steps: { race: { output: payload } } });
    assert.equal(r.eventId, `ev_${root}`);
    assert.equal(r.companyId, "co1");
    assert.equal(r.channelId, "ch1");
    assert.equal(r.mappingLabels.channelId, "ch1");
  }
});

// ---- third root: Flite order-placed -> transform -> mapped-event guard -> upsert-order ----

const ORDER_CHAIN = ["order_placed", "order_transform", "order_mapping", "order_guard", "order_upsert"];

test("order root: wired order_placed -> transform -> mapping -> guard -> upsert; existing roots untouched", async () => {
  const wf = load();
  assert.deepEqual(await validateWorkflow(wf), []);
  for (let i = 0; i < ORDER_CHAIN.length - 1; i++) {
    assert.deepEqual(wf.edges.filter((e: any) => e.from === ORDER_CHAIN[i]), [{ from: ORDER_CHAIN[i], to: ORDER_CHAIN[i + 1] }]);
  }
  assert.deepEqual(wf.edges.filter((e: any) => e.to === "order_upsert"), [{ from: "order_guard", to: "order_upsert" }]);
  assert.equal(wf.edges.filter((e: any) => e.from === "order_upsert").length, 0);
  assert.deepEqual(wf.edges.filter((e: any) => e.to === "race").map((e: any) => e.from).sort(), ["channel_changed", "channel_ticket_changed"]);
  assert.equal(node(wf, "order_placed").uses.connectionRef, "flite");
  assert.equal(node(wf, "order_mapping").uses.connectionRef, "cohost");
  assert.equal(node(wf, "order_upsert").uses.connectionRef, "cohost");
  assert.deepEqual(wf.variables.find((v: any) => v.key === "companyId"), { key: "companyId", type: "string", required: true });
  assert.ok(!/process\.env/.test(JSON.stringify(wf)));
  assert.ok(!/ticket[-_]changed/.test(JSON.stringify(wf.nodes.filter((n: any) => ORDER_CHAIN.includes(n.id)))));
});

const orderMutations: Array<[string, (wf: any) => void, RegExp]> = [
  ["order root missing", (wf) => {
    wf.nodes = wf.nodes.filter((n: any) => !ORDER_CHAIN.includes(n.id));
    wf.edges = wf.edges.filter((e: any) => !ORDER_CHAIN.includes(e.from) && !ORDER_CHAIN.includes(e.to));
  }, /order-placed trigger node/],
  ["order trigger wrong action", (wf) => { node(wf, "order_placed").uses.action = "order-refunded"; }, /order-placed trigger node|not in flite index|unknown/],
  ["guard edge removed", (wf) => {
    wf.edges = wf.edges.filter((e: any) => !(e.from === "order_mapping" && e.to === "order_guard") && !(e.from === "order_guard" && e.to === "order_upsert"));
    wf.edges.push({ from: "order_mapping", to: "order_upsert" });
  }, /missing edge order_mapping -> order_guard|only be reachable through the guard|without passing the order guard/],
  ["bypass edge transform -> upsert", (wf) => { wf.edges.push({ from: "order_transform", to: "order_upsert" }); }, /only be reachable through the guard|without passing the order guard/],
  ["bypass edge trigger -> upsert", (wf) => { wf.edges.push({ from: "order_placed", to: "order_upsert" }); }, /only be reachable through the guard|without passing the order guard/],
  ["upsert connectionRef missing", (wf) => { delete node(wf, "order_upsert").uses.connectionRef; }, /order_upsert must use connectionRef cohost/],
  ["order trigger connectionRef missing", (wf) => { delete node(wf, "order_placed").uses.connectionRef; }, /order_placed must use connectionRef flite/],
  ["mapping connectionRef missing", (wf) => { delete node(wf, "order_mapping").uses.connectionRef; }, /order_mapping must use connectionRef cohost/],
  ["flite connection undeclared", (wf) => { delete wf.connections.flite; }, /connectionRef flite is not declared/],
  ["upsert replaced by a non-upsert action", (wf) => { node(wf, "order_upsert").uses.action = "create-order"; }, /unknown vip\.cohost\.w6w action|missing order-root step upsert-order/],
  ["companyId variable missing", (wf) => { wf.variables = wf.variables.filter((v: any) => v.key !== "companyId"); }, /variable companyId/],
  ["transform companyId literal", (wf) => { node(wf, "order_transform").with.companyId = "co1"; }, /companyId must be bound to vars\.companyId/],
  ["mapping urn from wrong place", (wf) => { node(wf, "order_mapping").with.urn = { $: "steps.order_placed.output.orderId" }; }, /resolve-urn\.urn/],
  ["mapping narrowed by a labels filter", (wf) => { node(wf, "order_mapping").with.labels = { provider: "flite" }; }, /resolve-urn must take only urn \(found labels\)/],
  ["mapping narrowed by a type filter", (wf) => { node(wf, "order_mapping").with.type = "system-resource"; }, /resolve-urn must take only urn \(found type\)/],
  ["mapping back to find-mapped-resources", (wf) => { node(wf, "order_mapping").uses.action = "find-mapped-resources"; }, /unknown vip\.cohost\.w6w action|missing order-root step resolve-urn/],
  ["guard expected missing", (wf) => { delete node(wf, "order_guard").with.input.expected; }, /input\.expected must be exactly/],
  ["guard expected lacks channelId", (wf) => { delete node(wf, "order_guard").with.input.expected.channelId; }, /input\.expected must be exactly/],
  ["guard expected lacks env", (wf) => { delete node(wf, "order_guard").with.input.expected.env; }, /input\.expected must be exactly/],
  ["guard expected org literal", (wf) => { node(wf, "order_guard").with.input.expected.org = "o"; }, /expected\.org must be bound to vars\.org/],
  ["guard expected provider wrong", (wf) => { node(wf, "order_guard").with.input.expected.provider = "other"; }, /input\.expected must be exactly/],
  ["guard mapping unbound", (wf) => { node(wf, "order_guard").with.input.mapping = { $: "steps.order_transform.output" }; }, /input\.mapping must be bound/],
  ["guard does not throw", (wf) => { node(wf, "order_guard").with.code = "return { ok: true };"; }, /order guard code must throw/],
  ["guard input wrong", (wf) => { node(wf, "order_guard").with.input = { $: "steps.order_transform.output" }; }, /order guard input/],
  ["upsert data from raw order", (wf) => { node(wf, "order_upsert").with.data.order = { $: "steps.order_placed.output.order" }; }, /upsert-order\.data\.order/],
  ["upsert retry < 3", (wf) => { node(wf, "order_upsert").retry.maxAttempts = 1; }, /upsert-order step needs retry/],
];
for (const [name, mutate, re] of orderMutations) {
  test(`order root mutation rejected: ${name}`, async () => {
    const wf = load();
    mutate(wf);
    const errs = await validateWorkflow(wf);
    assert.ok(errs.some((e) => re.test(e)), `expected ${re}, got ${JSON.stringify(errs)}`);
  });
}

test("install --apply binds companyId and connections on the order-root nodes; order trigger keeps no channelId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  const tf = join(dir, "tok");
  writeFileSync(tf, "t\n");
  const { o, io } = mkIo();
  const args = ["install", FILE, "--w6w", "http://h", "--token-file", tf, "--var", "env=sandbox", "--var", "channelId=ch_X", "--var", "companyId=co_1",
    "--connection", "cohost=conn_c", "--connection", "flite=conn_f", "--apply"];
  assert.equal(await main(args, io), 0);
  const sent = JSON.parse(o.calls[0].init.body);
  assert.equal(sent.variables.find((v: any) => v.key === "companyId").default, "co_1");
  assert.equal(sent.connections.cohost.connection, "conn_c");
  assert.equal(sent.connections.flite.connection, "conn_f");
  for (const [id, ref] of [["order_placed", "flite"], ["order_mapping", "cohost"], ["order_upsert", "cohost"]]) {
    assert.equal(node(sent, id).uses.connectionRef, ref);
    assert.ok(sent.connections[ref].connection, `${id} -> ${ref} bound`);
  }
  for (const id of ["channel_changed", "channel_ticket_changed"]) assert.equal(node(sent, id).with.channelId, "ch_X");
  assert.equal(node(sent, "order_placed").with, undefined, "order trigger gets no channelId");
  assert.equal(node(sent, "order_guard").with.input.expected.channelId.$, "vars.channelId", "guard expected labels stay variable refs");
  const bad = mkIo();
  assert.equal(await main(["install", FILE, "--w6w", "http://h", "--token-file", tf, "--var", "bogus=1"], bad.io), 1);
});

// Executes the shipped guard code the way the script action does: the code body is a function body with `input` in scope.
const runGuard = (input: unknown) => new Function("input", String(node(load(), "order_guard").with.code))(input);

const EXPECTED = { provider: "flite", env: "sandbox", org: "o1", channelId: "ch1" };
const COMPANY = "co1";
/** The mapping doc exactly as register-urn-mapping / sync registers an event: labels carry provider/env/org/channelId/listingId/kind/id/eventId; resources = [{...labels, urn: mappedUrn}, {urn: cohost event}]. */
function mappingDoc(over: Record<string, unknown> = {}) {
  const mappedUrn = `urn:1:${COMPANY}:flite-sandbox:/events/9`;
  const labels = { provider: "flite", env: "sandbox", org: "o1", channelId: "ch1", listingId: "l1", kind: "event", id: "9", eventId: "9", ...over };
  return { urn: mappedUrn, labels, resources: [{ ...labels, urn: mappedUrn }, { urn: `urn:1:${COMPANY}:cohost-falcon:/events/evt_1` }] };
}

test("guard: a mapping registered by this channel passes", () => {
  assert.deepEqual(runGuard({ mapping: mappingDoc(), expected: EXPECTED }), { ok: true });
});

test("guard: unmapped / foreign mappings throw 'unmapped Flite event'", () => {
  const cases: Array<[string, unknown]> = [
    ["undefined mapping", undefined],
    ["null mapping", null],
    ["empty resources", { ...mappingDoc(), resources: [] }],
    ["resources not an array", { ...mappingDoc(), resources: { 0: { urn: "x" } } }],
    ["no resources key", { urn: "u", labels: mappingDoc().labels }],
    ["missing labels", { urn: "u", resources: mappingDoc().resources }],
    ["empty labels", { ...mappingDoc(), labels: {} }],
    ["different channelId", mappingDoc({ channelId: "ch2" })],
    ["different env", mappingDoc({ env: "production" })],
    ["different org", mappingDoc({ org: "o2" })],
    ["different provider", mappingDoc({ provider: "eventbrite" })],
    ["label removed (channelId)", mappingDoc({ channelId: undefined })],
  ];
  for (const [name, mapping] of cases) {
    assert.throws(() => runGuard({ mapping, expected: EXPECTED }), /unmapped Flite event/, name);
  }
  assert.throws(() => runGuard(undefined), /unmapped Flite event/, "no input at all");
  assert.throws(() => runGuard({ mapping: mappingDoc() }), /unmapped Flite event/, "no expected labels supplied fails closed");
  assert.throws(() => runGuard({ mapping: mappingDoc(), expected: { ...EXPECTED, channelId: undefined } }), /unmapped Flite event/, "unset expected var fails closed");
});

test("order root uses resolve-urn (no labels/type filter), not find-mapped-resources", () => {
  const wf = load();
  const order = wf.nodes.filter((n: any) => ORDER_CHAIN.includes(n.id));
  assert.ok(!order.some((n: any) => n.uses.action === "find-mapped-resources"));
  assert.ok(!JSON.stringify(order).includes("find-mapped-resources"));
  const m = node(wf, "order_mapping");
  assert.deepEqual([m.uses.app, m.uses.action, m.uses.connectionRef], ["vip.cohost.w6w", "resolve-urn", "cohost"]);
  assert.deepEqual(Object.keys(m.with), ["urn"], "no labels filter and no type param");
  assert.deepEqual(m.with.urn, { $: "steps.order_transform.output.order.contextId" });
  assert.deepEqual(node(wf, "order_guard").with.input.mapping, { $: "steps.order_mapping.output" });
});

test("order expressions: transform reads the trigger order; upsert reads the transformed order; mapping reads the transformed contextId", () => {
  const wf = load();
  const ctx = {
    vars: { env: "sandbox", org: "o", channelId: "ch1", companyId: "co1" },
    steps: {
      order_placed: { output: { orderId: "o1", order: { _id: "o1" } } },
      order_transform: { output: { order: { contextId: "urn:1:co1:flite-sandbox:/events/e1", total: 5 } } },
    },
  };
  const t = resolve(node(wf, "order_transform").with, ctx);
  assert.deepEqual(t, { order: { _id: "o1" }, companyId: "co1", env: "sandbox" });
  assert.equal(node(wf, "order_transform").with.order.$, "steps.order_placed.output.order");
  const m = resolve(node(wf, "order_mapping").with, ctx);
  assert.deepEqual(m, { urn: "urn:1:co1:flite-sandbox:/events/e1" });
  const doc = mappingDoc();
  const g = resolve(node(wf, "order_guard").with, { ...ctx, steps: { ...ctx.steps, order_mapping: { output: doc } } });
  assert.deepEqual(g.input, { mapping: doc, expected: { provider: "flite", env: "sandbox", org: "o", channelId: "ch1" } });
  assert.equal(node(wf, "order_upsert").with.data.order.$, "steps.order_transform.output.order");
  assert.deepEqual(resolve(node(wf, "order_upsert").with, ctx).data, { order: ctx.steps.order_transform.output.order });
});

test("idempotency: the order write is upsert-order (never a create action), retried", () => {
  const wf = load();
  const u = node(wf, "order_upsert");
  assert.deepEqual([u.uses.app, u.uses.action], ["vip.cohost.w6w", "upsert-order"]);
  assert.ok(u.retry.maxAttempts >= 3);
  const writers = wf.nodes.filter((n: any) => ORDER_CHAIN.includes(n.id) && /create|insert|add/i.test(n.uses.action));
  assert.deepEqual(writers, []);
});
