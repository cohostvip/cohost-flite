import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bindChannelTriggers, coerceVar, IMPORT_ROOT_IDS, main, validateImportRoot, validateWorkflow } from "../scripts/workflow.ts";
// Side-effect import: no npm script runs tests/import-scripts.test.ts (3-page fixture, idempotency, unmapped/foreign-channel skip), so test:workflow runs it through here.
import "./import-scripts.test.ts";

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
  ["remove the channel trigger", (wf) => {
    wf.nodes = wf.nodes.filter((n: any) => n.id !== "channel_changed");
    wf.edges = wf.edges.filter((e: any) => e.from !== "channel_changed");
  }, /exactly one channel trigger node/],
  ["old two-trigger shape rejected", (wf) => {
    wf.nodes.push({ id: "channel_ticket_changed", uses: { app: "vip.cohost.w6w", action: "channel-changed", trigger: true, connectionRef: "cohost" }, with: { channelId: { $: "vars.channelId" } } });
    wf.edges.push({ from: "channel_ticket_changed", to: "snapshot" });
  }, /exactly one channel trigger node/],
  ["old event-changed key rejected", (wf) => { node(wf, "channel_changed").uses.action = "channel-event-changed"; }, /unknown trigger|exactly one channel trigger node/],
  ["old ticket-changed key rejected", (wf) => { node(wf, "channel_changed").uses.action = "channel-ticket-changed"; }, /unknown trigger|exactly one channel trigger node/],
  ["channel trigger without channelId", (wf) => { delete node(wf, "channel_changed").with.channelId; }, /channel_changed must carry a channelId/],
  ["dangling edge", (wf) => wf.edges.push({ from: "sync", to: "ghost" }), /unknown node ghost/],
  ["renamed A key", (wf) => { node(wf, "register").uses.action = "register-urn-mapping"; }, /unknown vip\.cohost\.w6w action/],
  ["register retry < 3", (wf) => { node(wf, "register").retry.maxAttempts = 2; }, /maxAttempts >= 3/],
  ["fail step before register", (wf) => {
    wf.edges = wf.edges.filter((e: any) => !(e.from === "sync" && e.to === "register") && !(e.from === "register" && e.to === "report"));
    wf.edges.push({ from: "sync", to: "report" }, { from: "report", to: "register" });
  }, /terminal step|missing edge/],
  ["unknown F action", (wf) => { node(wf, "sync").uses.action = "sync-events"; }, /not in flite index/],
  ["listingId in mappingLabels", (wf) => { node(wf, "snapshot").with.mappingLabels.listingId = "x"; }, /mappingLabels/],
  ["env label brought back", (wf) => { node(wf, "snapshot").with.mappingLabels.env = "sandbox"; }, /mappingLabels must be exactly/],
  ["mappingLabels channelId literal", (wf) => { node(wf, "snapshot").with.mappingLabels.channelId = "ch1"; }, /mappingLabels must be exactly/],
  ["expectedEnv brought back", (wf) => { node(wf, "sync").with.expectedEnv = "production"; }, /sync must not pass expectedEnv/],
  ["env passed to the channel transformer", (wf) => { node(wf, "desired").with.env = "sandbox"; }, /channel-event-to-flite must not pass env/],
  ["org passed to the channel transformer", (wf) => { node(wf, "desired").with.org = "o1"; }, /channel-event-to-flite must not pass org/],
  ["env variable brought back", (wf) => { wf.variables.push({ key: "env", type: "string", required: true }); }, /variables must be exactly channelId/],
  ["vars.env reference", (wf) => { node(wf, "sync").with.extra = { $: "vars.env" }; }, /vars\.env .* forbidden/],
  ["snapshot companyId passed", (wf) => { node(wf, "snapshot").with.companyId = { $: "steps.channel_changed.output.meta.companyId" }; }, /snapshot must not pass companyId/],
  ["snapshot input missing on transformer", (wf) => { delete node(wf, "desired").with.snapshot; }, /snapshot must be bound/],
  ["report code does not throw", (wf) => { node(wf, "report").with.code = "return { ok: true };"; }, /must throw when errors/],
  ["report throws unconditionally", (wf) => { node(wf, "report").with.code = "throw new Error('x');"; }, /must throw when errors/],
  ["report reachable around register", (wf) => { wf.edges.push({ from: "sync", to: "report" }); }, /without passing register|must not be reachable directly/],
  ["id outside server grammar", (wf) => { wf.id = "wf_flite_sales_channel"; }, /id must match/],
  ["key with underscore", (wf) => { wf.key = "flite_sales_channel"; }, /key must be an account slug/],
  ["embedded connection id", (wf) => { node(wf, "sync").uses.connection = "conn_1"; }, /embeds a connection id/],
];
mutations.push(
  ["step without a note", (wf) => { delete node(wf, "sync").notes; }, /node sync: needs a notes line/],
  ["step without a position", (wf) => { delete node(wf, "sync").position; }, /node sync: needs a position/],
  ["canvas removed", (wf) => { delete wf.canvas; }, /canvas with sections and notes is required/],
  ["step left out of every section", (wf) => {
    for (const s of wf.canvas.sections) s.nodes = s.nodes.filter((id: string) => id !== "page_fetch");
  }, /node page_fetch is in no canvas section/],
  ["step in two sections", (wf) => { wf.canvas.sections[0].nodes.push("order_upsert"); }, /node order_upsert is in two sections/],
  ["section names a renamed step", (wf) => { wf.canvas.sections[1].nodes.push("ghost"); }, /names unknown node ghost/],
  ["bad section colour", (wf) => { wf.canvas.sections[0].color = "blue"; }, /color must match #rrggbb/],
  ["duplicate canvas id", (wf) => { wf.canvas.notes[0].id = wf.canvas.sections[0].id; }, /already used on the canvas/],
  ["unknown canvas key", (wf) => { wf.canvas.frames = []; }, /canvas\.frames is not a known key/],
);

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
    assert.equal(await main([cmd, FILE, ...base], io), 0);
    assert.equal(o.calls.length, 0, "no request without --apply");
    assert.equal(o.out.length, 1);
    assert.equal(o.out[0], cmd === "install" ? "POST http://h/workflows?project=p" : "POST http://h/workflows/wf_flite-sales-channel/publish");
  }
  const inst = mkIo();
  assert.equal(await main(["install", FILE, ...base, "--connection", "cohost=conn_c", "--connection", "flite=conn_f", "--apply"], inst.io), 0);
  const sent = JSON.parse(inst.o.calls[0].init.body);
  assert.equal(sent.id, "wf_flite-sales-channel");
  assert.equal(sent.connections.cohost.connection, "conn_c");
  assert.equal(sent.connections.flite.connection, "conn_f");
  assert.deepEqual(sent.variables.map((v: any) => v.key), ["channelId"]);
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

test("workflow has the one channel-scoped root plus the Flite order root, and no old trigger keys", () => {
  const wf = load();
  const all = wf.nodes.filter((n: any) => n.uses.trigger === true);
  assert.deepEqual(all.map((n: any) => [n.id, n.uses.app, n.uses.action]).sort(), [
    ["channel_changed", "vip.cohost.w6w", "channel-changed"],
    ["order_placed", "vip.cohost.flite", "order-placed"],
  ]);
  const t = all.filter((n: any) => n.id !== "order_placed");
  for (const n of t) assert.deepEqual(n.with.channelId, { $: "vars.channelId" });
  assert.deepEqual(node(wf, "channel_changed").with.actions, ["event.change", "ticket.change"]);
  assert.deepEqual(wf.edges.filter((e: any) => e.from === "channel_changed"), [{ from: "channel_changed", to: "snapshot" }]);
  assert.ok(!wf.nodes.some((n: any) => n.id === "channel_ticket_changed"));
  assert.ok(!/channel[-_](event|ticket)[-_]changed/.test(readFileSync(FILE, "utf8")));
});

test("install --apply with --var channelId binds the literal on the channel trigger node", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  const tf = join(dir, "tok");
  writeFileSync(tf, "t\n");
  const { o, io } = mkIo();
  assert.equal(await main(["install", FILE, "--w6w", "http://h", "--token-file", tf, "--var", "channelId=ch_X", "--apply"], io), 0);
  const sent = JSON.parse(o.calls[0].init.body);
  assert.equal(node(sent, "channel_changed").with.channelId, "ch_X");
  const src = load();
  bindChannelTriggers(src, "ch_Y");
  assert.equal(node(src, "channel_changed").with.channelId, "ch_Y");
});

// Minimal resolver for {"$": "a.b.c"} refs, enough to prove which payload path each ref reads.
const resolve = (v: any, ctx: any): any => {
  if (v && typeof v === "object" && typeof v.$ === "string") return v.$.split(".").reduce((a: any, k: string) => a?.[k], ctx);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, ctx)]));
  return v;
};

test("snapshot expressions resolve channelId/eventId; companyId is the hidden const, not passed", () => {
  const w = node(load(), "snapshot").with;
  assert.equal(w.eventId.$, "steps.channel_changed.output.meta.eventId");
  assert.equal("companyId" in w, false);
  assert.equal(w.channelId.$, "vars.channelId");
  assert.deepEqual(w.mappingLabels, { provider: "flite", channelId: { $: "vars.channelId" } });
  for (const root of ["event.change", "ticket.change"]) {
    const payload = { meta: { channelId: "ch1", eventId: `ev_${root}`, companyId: "co1" } };
    const r = resolve(w, { vars: { channelId: "ch1" }, steps: { channel_changed: { output: payload } } });
    assert.equal(r.eventId, `ev_${root}`);
    assert.equal(r.channelId, "ch1");
    assert.equal(r.mappingLabels.channelId, "ch1");
  }
  assert.deepEqual(node(load(), "desired").with, { snapshot: { $: "steps.snapshot.output" } });
  assert.deepEqual(node(load(), "sync").with, { desired: { $: "steps.desired.output.desired" } });
});

// ---- third root: Flite order-placed -> transform -> upsert-order (the Cohost order API resolves URNs) ----

const ORDER_CHAIN = ["order_placed", "order_transform", "order_upsert"];

test("order root: wired order_placed -> transform -> upsert (no URN pre-resolve); existing roots untouched", async () => {
  const wf = load();
  assert.deepEqual(await validateWorkflow(wf), []);
  for (let i = 0; i < ORDER_CHAIN.length - 1; i++) {
    assert.deepEqual(wf.edges.filter((e: any) => e.from === ORDER_CHAIN[i]), [{ from: ORDER_CHAIN[i], to: ORDER_CHAIN[i + 1] }]);
  }
  assert.deepEqual(wf.edges.filter((e: any) => e.to === "order_upsert"), [{ from: "order_transform", to: "order_upsert" }]);
  assert.ok(!wf.nodes.some((n: any) => ["order_mapping", "order_guard"].includes(n.id) || n.uses?.action === "resolve-urn"));
  assert.equal(wf.edges.filter((e: any) => e.from === "order_upsert").length, 0);
  assert.deepEqual(wf.edges.filter((e: any) => e.to === "snapshot").map((e: any) => e.from).sort(), ["channel_changed"]);
  assert.equal(node(wf, "order_placed").uses.connectionRef, "flite");
  assert.equal(node(wf, "order_upsert").uses.connectionRef, "cohost");
  assert.deepEqual(wf.variables.map((v: any) => v.key), ["channelId"]);
  assert.ok(wf.variables.every((v: any) => v.required === true));
  assert.ok(!/vars\.(companyId|currency|importEventId|importMaxPages)/.test(JSON.stringify(wf)));
  assert.ok(!/process\.env/.test(JSON.stringify(wf)));
  assert.ok(!/ticket[-_]changed/.test(JSON.stringify(wf.nodes.filter((n: any) => ORDER_CHAIN.includes(n.id)))));
});

const orderMutations: Array<[string, (wf: any) => void, RegExp]> = [
  ["order root missing", (wf) => {
    wf.nodes = wf.nodes.filter((n: any) => !ORDER_CHAIN.includes(n.id));
    wf.edges = wf.edges.filter((e: any) => !ORDER_CHAIN.includes(e.from) && !ORDER_CHAIN.includes(e.to));
  }, /order-placed trigger node/],
  ["order trigger wrong action", (wf) => { node(wf, "order_placed").uses.action = "order-refunded"; }, /order-placed trigger node|not in flite index|unknown/],
  ["bypass edge transform -> upsert duplicated trigger", (wf) => { wf.edges.push({ from: "order_placed", to: "order_upsert" }); }, /order trigger must only feed transform-order|upsert-order must only be fed by transform-order/],
  ["resolve-urn step inserted on the order path", (wf) => {
    wf.nodes.push({ id: "order_mapping", uses: { app: "vip.cohost.w6w", action: "resolve-urn", connectionRef: "cohost" }, with: { urn: { $: "steps.order_transform.output.order.contextId" } } });
    wf.edges = wf.edges.filter((e: any) => !(e.from === "order_transform" && e.to === "order_upsert"));
    wf.edges.push({ from: "order_transform", to: "order_mapping" }, { from: "order_mapping", to: "order_upsert" });
  }, /resolve-urn is not allowed/],
  ["guard script inserted on the order path", (wf) => {
    wf.nodes.push({ id: "order_guard", uses: { app: "@w6w/script", action: "run" }, with: { code: "return 1;", input: {} } });
    wf.edges = wf.edges.filter((e: any) => !(e.from === "order_transform" && e.to === "order_upsert"));
    wf.edges.push({ from: "order_transform", to: "order_guard" }, { from: "order_guard", to: "order_upsert" });
  }, /must not be on the order path|must only feed upsert-order|must only be fed by transform-order/],
  ["upsert connectionRef missing", (wf) => { delete node(wf, "order_upsert").uses.connectionRef; }, /order_upsert must use connectionRef cohost/],
  ["order trigger connectionRef missing", (wf) => { delete node(wf, "order_placed").uses.connectionRef; }, /order_placed must use connectionRef flite/],
  ["flite connection undeclared", (wf) => { delete wf.connections.flite; }, /connectionRef flite is not declared/],
  ["upsert replaced by a non-upsert action", (wf) => { node(wf, "order_upsert").uses.action = "create-order"; }, /unknown vip\.cohost\.w6w action|missing order-root step upsert-order/],
  ["companyId variable rejected", (wf) => { wf.variables.push({ key: "companyId", type: "string", required: true }); }, /variables must be exactly channelId/],
  ["extra variable rejected", (wf) => { wf.variables.push({ key: "currency", type: "string", default: "USD" }); }, /variables must be exactly/],
  ["variable missing", (wf) => { wf.variables = []; }, /variables must be exactly/],
  ["vars.companyId ref rejected", (wf) => { node(wf, "snapshot").with.companyId = { $: "vars.companyId" }; }, /vars\.companyId is forbidden/],
  ["transform companyId literal", (wf) => { node(wf, "order_transform").with.companyId = "co1"; }, /companyId must not be passed/],
  ["transform companyId bound to vars", (wf) => { node(wf, "order_transform").with.companyId = { $: "vars.companyId" }; }, /companyId must not be bound to vars\.companyId/],
  ["transform connectionId bound to vars", (wf) => { node(wf, "order_transform").with.connectionId = { $: "vars.connectionId" }; }, /connectionId must not be bound to vars\.connectionId/],
  ["transform connectionId not from the order trigger meta", (wf) => { node(wf, "order_transform").with.connectionId = "c1"; }, /transform-order\.connectionId must be bound to steps\.order_placed\.meta\.connectionId/],
  ["desired transformer given companyId via vars", (wf) => { node(wf, "desired").with.companyId = { $: "vars.companyId" }; }, /transformer node desired: companyId must not be bound to vars\.companyId/],
  ["upsert data from raw order", (wf) => { node(wf, "order_upsert").with.data = { order: { $: "steps.order_placed.output.order" } }; }, /upsert-order\.data must be bound/],
  ["upsert data only the order (no source, no attendees)", (wf) => { node(wf, "order_upsert").with.data = { order: { $: "steps.order_transform.output.data.order" } }; }, /upsert-order\.data must be bound/],
  ["transform eventId brought back", (wf) => { node(wf, "order_transform").with.eventId = "e1"; }, /transform-order must not pass eventId/],
  ["transform channelId unbound", (wf) => { delete node(wf, "order_transform").with.channelId; }, /transform-order\.channelId must be bound to vars\.channelId/],
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
  const args = ["install", FILE, "--w6w", "http://h", "--token-file", tf, "--var", "channelId=ch_X",
    "--connection", "cohost=conn_c", "--connection", "flite=conn_f", "--apply"];
  assert.equal(await main(args, io), 0);
  const sent = JSON.parse(o.calls[0].init.body);
  assert.deepEqual(sent.variables.map((v: any) => v.key), ["channelId"]);
  assert.equal(sent.connections.cohost.connection, "conn_c");
  assert.equal(sent.connections.flite.connection, "conn_f");
  for (const [id, ref] of [["order_placed", "flite"], ["order_upsert", "cohost"]]) {
    assert.equal(node(sent, id).uses.connectionRef, ref);
    assert.ok(sent.connections[ref].connection, `${id} -> ${ref} bound`);
  }
  assert.equal(node(sent, "channel_changed").with.channelId, "ch_X");
  assert.equal(node(sent, "order_placed").with, undefined, "order trigger gets no channelId");
  const bad = mkIo();
  assert.equal(await main(["install", FILE, "--w6w", "http://h", "--token-file", tf, "--var", "bogus=1"], bad.io), 1);
});

test("order expressions: transform reads the trigger order + Flite connection; upsert sends the whole transformed body", () => {
  const wf = load();
  const data = { order: { contextId: "urn:1:co1:conn_f:/events/e1" }, source: { system: "flite" }, attendees: [] };
  const ctx = {
    vars: { channelId: "ch1" },
    steps: {
      order_placed: { output: { orderId: "o1", order: { _id: "o1" } }, meta: { connectionId: "conn_f" } },
      order_transform: { output: { data, urn: "u" } },
    },
  };
  const t = resolve(node(wf, "order_transform").with, ctx);
  assert.deepEqual(t, { order: { _id: "o1" }, connectionId: "conn_f", channelId: "ch1" });
  assert.equal(node(wf, "order_transform").with.order.$, "steps.order_placed.output.order");
  assert.deepEqual(node(wf, "order_upsert").with, { data: { $: "steps.order_transform.output.data" } });
  assert.deepEqual(resolve(node(wf, "order_upsert").with, ctx).data, data);
});

test("idempotency: the order write is upsert-order (never a create action), retried", () => {
  const wf = load();
  const u = node(wf, "order_upsert");
  assert.deepEqual([u.uses.app, u.uses.action], ["vip.cohost.w6w", "upsert-order"]);
  assert.ok(u.retry.maxAttempts >= 3);
  const writers = wf.nodes.filter((n: any) => ORDER_CHAIN.includes(n.id) && /create|insert|add/i.test(n.uses.action));
  assert.deepEqual(writers, []);
});

// ---- fourth root: detached "import all orders" flow ----

const IMPORT_IDS: readonly string[] = IMPORT_ROOT_IDS;
const OTHER_ROOT_IDS = (wf: any) => wf.nodes.map((n: any) => n.id).filter((id: string) => !IMPORT_IDS.includes(id));

test("import root: four roots, the import root is detached from the other three", async () => {
  const wf = load();
  assert.deepEqual(await validateWorkflow(wf), []);
  assert.deepEqual(validateImportRoot(wf, wf.nodes, wf.edges), []);
  assert.deepEqual(wf.nodes.filter((n: any) => n.uses.trigger === true).map((n: any) => n.id).sort(), ["channel_changed", "order_placed"]);
  assert.deepEqual(node(wf, "import_start").uses, { app: "@w6w/trigger", action: "manual" });
  assert.equal(wf.edges.filter((e: any) => e.to === "import_start").length, 0);
  // not one edge crosses the boundary, in either direction
  const others = new Set(OTHER_ROOT_IDS(wf));
  assert.equal(wf.edges.filter((e: any) => others.has(e.from) !== others.has(e.to)).length, 0);
  // no node of the other roots reads an import step, and vice versa
  for (const n of wf.nodes) {
    const refs = [...JSON.stringify(n.with ?? {}).matchAll(/"steps\.([A-Za-z0-9_-]+)\./g)].map((m) => m[1]);
    for (const r of refs) assert.equal(IMPORT_IDS.includes(n.id), IMPORT_IDS.includes(r), `${n.id} reads steps.${r}`);
  }
  assert.deepEqual(wf.edges.filter((e: any) => e.to === "snapshot").map((e: any) => e.from).sort(), ["channel_changed"]);
  assert.deepEqual(wf.edges.filter((e: any) => e.to === "imp_upsert"), [{ from: "imp_transform", to: "imp_upsert" }]);
  assert.deepEqual(wf.edges.filter((e: any) => e.to === "import_each_order"), [{ from: "import_complete", to: "import_each_order" }]);
  assert.equal(node(wf, "imp_upsert").uses.action, "upsert-order");
});

test("race node and steps.race refs are rejected", async () => {
  const a = load();
  a.nodes.push({ id: "race", uses: { app: "@w6w/race", action: "race" } });
  assert.ok((await validateWorkflow(a)).some((e) => /@w6w\/race node is forbidden/.test(e)));
  const b = load();
  node(b, "snapshot").with.eventId = { $: "steps.race.output.meta.eventId" };
  assert.ok((await validateWorkflow(b)).some((e) => /steps\.race references are forbidden/.test(e)));
});

const importMutations: Array<[string, (wf: any) => void, RegExp]> = [
  ["import root missing", (wf) => {
    wf.nodes = wf.nodes.filter((n: any) => !IMPORT_IDS.includes(n.id));
    wf.edges = wf.edges.filter((e: any) => !IMPORT_IDS.includes(e.from) && !IMPORT_IDS.includes(e.to));
  }, /missing import-root step import_start/],
  ["import start connected to the snapshot", (wf) => { wf.edges.push({ from: "import_start", to: "snapshot" }); }, /import root must be detached.*import_start -> snapshot/],
  ["order root connected into the import root", (wf) => { wf.edges.push({ from: "order_upsert", to: "import_list_events" }); }, /import root must be detached.*order_upsert -> import_list_events/],
  ["import root feeding the order upsert", (wf) => { wf.edges.push({ from: "import_complete", to: "order_upsert" }); }, /import root must be detached.*import_complete -> order_upsert/],
  ["trigger feeding import start", (wf) => { wf.edges.push({ from: "channel_changed", to: "import_start" }); }, /import root must be detached|import_start must have no inbound edge/],
  ["import step reads another root's output", (wf) => { node(wf, "imp_transform").with.extra = { $: "steps.order_transform.output" }; }, /across the import root boundary/],
  ["other root reads an import step", (wf) => { node(wf, "report").with.input.extra = { $: "steps.import_flatten.output" }; }, /across the import root boundary/],
  ["import start made a subscribed trigger", (wf) => { node(wf, "import_start").uses.trigger = true; }, /import-root step import_start must be|two trigger nodes|unknown trigger/],
  ["upsert reachable around the guard", (wf) => { wf.edges.push({ from: "import_flatten", to: "import_each_order" }); }, /only be reachable through import_complete|without passing import_complete|unexpected import-root edge/],
  ["upsert fed straight from the loop's start", (wf) => { wf.edges.push({ from: "import_start", to: "imp_upsert" }); }, /imp_upsert must only follow imp_transform|without passing import_complete|unexpected import-root edge/],
  ["guard edge removed", (wf) => {
    wf.edges = wf.edges.filter((e: any) => !(e.from === "import_flatten" && e.to === "import_complete") && !(e.from === "import_complete" && e.to === "import_each_order"));
    wf.edges.push({ from: "import_flatten", to: "import_each_order" });
  }, /missing edge import_flatten -> import_complete|only be reachable through import_complete/],
  ["order loop body not contiguous (edge dropped)", (wf) => { wf.edges = wf.edges.filter((e: any) => !(e.from === "imp_transform" && e.to === "imp_upsert")); }, /missing edge imp_transform -> imp_upsert/],
  ["order loop body reordered", (wf) => { node(wf, "import_each_order").with.body = ["imp_upsert", "imp_transform"]; }, /import_each_order body must be exactly/],
  ["order loop body missing the upsert", (wf) => { node(wf, "import_each_order").with.body = ["imp_transform"]; }, /import_each_order body must be exactly|imp_upsert must be in the import_each_order/],
  ["body step edge leaks out of the loop", (wf) => { wf.edges.push({ from: "imp_upsert", to: "import_complete" }); }, /body edge leaks|must have no outgoing edge/],
  ["body step edge leaks into the loop", (wf) => { wf.edges.push({ from: "import_event_ids", to: "ev_target" }); }, /body edge leaks/],
  ["foreach wired to a body step", (wf) => { wf.edges.push({ from: "import_each_event", to: "ev_snapshot" }); }, /body edge leaks|unexpected import-root edge/],
  ["body step shared by two loops", (wf) => { node(wf, "import_each_page").with.body = ["page_fetch", "ev_target"]; }, /import_each_page body must be exactly/],
  ["page loop iterates the wrong list", (wf) => { node(wf, "import_each_page").with.items = { $: "steps.import_pages.output.skipped" }; }, /import_each_page\.items must be bound/],
  ["upsert replaced by a create action", (wf) => { node(wf, "imp_upsert").uses.action = "create-order"; }, /import-root step imp_upsert must be vip\.cohost\.w6w\/upsert-order|unknown vip\.cohost\.w6w action/],
  ["upsert data from the raw Flite order", (wf) => { node(wf, "imp_upsert").with.data = { order: { $: "foreach.item.order" } }; }, /imp_upsert\.data must be bound/],
  ["upsert retry < 3", (wf) => { node(wf, "imp_upsert").retry.maxAttempts = 1; }, /imp_upsert needs retry/],
  ["transform connectionId from vars", (wf) => { node(wf, "imp_transform").with.connectionId = { $: "vars.connectionId" }; }, /imp_transform\.connectionId must be bound to steps\.import_conn\.meta\.connectionId/],
  ["transform companyId via vars", (wf) => { node(wf, "imp_transform").with.companyId = { $: "vars.companyId" }; }, /vars\.companyId is forbidden|imp_transform: companyId must not be bound to vars\.companyId/],
  ["transform eventId brought back", (wf) => { node(wf, "imp_transform").with.eventId = { $: "foreach.item.eventId" }; }, /imp_transform must not pass eventId/],
  ["transform channelId unbound", (wf) => { delete node(wf, "imp_transform").with.channelId; }, /imp_transform\.channelId must be bound/],
  ["list-orders eventId literal", (wf) => { node(wf, "page_fetch").with.eventId = "e1"; }, /page_fetch must read/],
  ["list-orders unretried", (wf) => { delete node(wf, "page_fetch").retry; }, /page_fetch needs retry/],
  ["max pages literal", (wf) => { node(wf, "import_pages").with.maxPages = 5; }, /maxPages must be the literal 10/],
  ["truncation guard does not throw", (wf) => { node(wf, "import_complete").with.code = "return { ok: true };"; }, /import_complete code must throw/],
  ["truncation guard input unbound", (wf) => { node(wf, "import_complete").with.input.truncated = []; }, /import_complete\.input\.truncated must be bound/],
  ["snapshot carries a listingId", (wf) => { node(wf, "ev_snapshot").with.listingId = "l1"; }, /ev_snapshot must not carry listingId/],
  ["snapshot labels lack channelId", (wf) => { delete node(wf, "ev_snapshot").with.mappingLabels.channelId; }, /ev_snapshot\.mappingLabels must be exactly/],
  ["target expected gains env", (wf) => { node(wf, "ev_target").with.input.expected.env = "sandbox"; }, /ev_target\.input\.expected must be exactly/],
  ["target not scoped to the Flite connection", (wf) => { delete node(wf, "ev_target").with.input.connectionId; }, /ev_target\.input\.connectionId must be bound/],
  ["target companyId from the account const", (wf) => { node(wf, "ev_target").with.input.companyId = { $: "const.account_id" }; }, /ev_target\.input\.companyId must be bound to steps\.ev_snapshot\.output\.companyId/],
  ["target expected channelId literal", (wf) => { node(wf, "ev_target").with.input.expected.channelId = "ch1"; }, /ev_target\.input\.expected must be exactly/],
  ["target mappings unbound", (wf) => { node(wf, "ev_target").with.input.mappings = []; }, /ev_target\.input\.mappings must be bound/],
  ["target does not verify labels", (wf) => { node(wf, "ev_target").with.code = "return { mapped: true };"; }, /ev_target code must verify mapping labels/],
  ["list events not scoped to the channel", (wf) => { node(wf, "import_list_events").with.channelId = "ch1"; }, /import_list_events\.channelId must be bound/],
  ["import maxPages bound to a var", (wf) => { node(wf, "import_pages").with.maxPages = { $: "vars.importMaxPages" }; }, /maxPages must be the literal 10/],
  ["import ev_snapshot companyId passed", (wf) => { node(wf, "ev_snapshot").with.companyId = "co1"; }, /ev_snapshot must not pass companyId/],
  ["import_event_ids binds eventId", (wf) => { node(wf, "import_event_ids").with.input.eventId = "e1"; }, /must not bind eventId/],
  ["embedded connection id", (wf) => { node(wf, "imp_upsert").uses.connection = "conn_1"; }, /embeds a connection id/],
  ["upsert connectionRef missing", (wf) => { delete node(wf, "imp_upsert").uses.connectionRef; }, /imp_upsert must use connectionRef cohost/],
  ["list-orders connectionRef missing", (wf) => { delete node(wf, "page_fetch").uses.connectionRef; }, /page_fetch must use connectionRef flite/],
  ["snapshot connectionRef missing", (wf) => { delete node(wf, "ev_snapshot").uses.connectionRef; }, /ev_snapshot must use connectionRef cohost/],
  ["list-channel-events connectionRef missing", (wf) => { delete node(wf, "import_list_events").uses.connectionRef; }, /import_list_events must use connectionRef cohost/],
  ["flite connection undeclared", (wf) => { delete wf.connections.flite; }, /connectionRef flite is not declared/],
  ["stray connectionRef on a script step", (wf) => { node(wf, "import_complete").uses.connectionRef = "cohost"; }, /import_complete must not use a connectionRef/],
];
for (const [name, mutate, re] of importMutations) {
  test(`import root mutation rejected: ${name}`, async () => {
    const wf = load();
    mutate(wf);
    const errs = await validateWorkflow(wf);
    assert.ok(errs.some((e) => re.test(e)), `expected ${re}, got ${JSON.stringify(errs)}`);
  });
}

test("install --var: only channelId is accepted; coerceVar still coerces typed values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  const tf = join(dir, "tok");
  writeFileSync(tf, "t\n");
  const { o, io } = mkIo();
  assert.equal(await main(["install", FILE, "--w6w", "http://h", "--token-file", tf, "--var", "channelId=ch_X", "--apply"], io), 0);
  const sent = JSON.parse(o.calls[0].init.body);
  assert.strictEqual(sent.variables.find((x: any) => x.key === "channelId").default, "ch_X");
  for (const gone of ["env", "org", "eventId", "companyId", "currency", "importEventId", "importMaxPages"]) {
    const e = mkIo();
    assert.equal(await main(["install", FILE, "--w6w", "http://h", "--token-file", tf, "--var", `${gone}=x`, "--apply"], e.io), 1);
    assert.match(e.o.err.join("\n"), new RegExp(`unknown --var ${gone}`));
    assert.equal(e.o.calls.length, 0, "nothing sent for a removed variable");
  }
  assert.strictEqual(coerceVar({ key: "k", type: "number" }, " 7 "), 7);
  assert.strictEqual(coerceVar({ key: "k", type: "boolean" }, "true"), true);
  assert.throws(() => coerceVar({ key: "k", type: "boolean" }, "yes"), /true or false/);
  assert.strictEqual(coerceVar({ key: "k", type: "string" }, "20"), "20");
});

test("install --apply binds the import root's cohost and flite connections; channel triggers still bound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  const tf = join(dir, "tok");
  writeFileSync(tf, "t\n");
  const { o, io } = mkIo();
  const args = ["install", FILE, "--w6w", "http://h", "--token-file", tf, "--var", "channelId=ch_X",
    "--connection", "cohost=conn_c", "--connection", "flite=conn_f", "--apply"];
  assert.equal(await main(args, io), 0);
  const sent = JSON.parse(o.calls[0].init.body);
  assert.deepEqual(validateImportRoot(sent, sent.nodes, sent.edges), []);
  for (const [id, ref, conn] of [["import_list_events", "cohost", "conn_c"], ["ev_snapshot", "cohost", "conn_c"], ["imp_upsert", "cohost", "conn_c"], ["import_conn", "flite", "conn_f"], ["page_fetch", "flite", "conn_f"]]) {
    assert.equal(node(sent, id).uses.connectionRef, ref);
    assert.equal(sent.connections[ref].connection, conn, `${id} -> ${ref} bound at install`);
    assert.equal(node(sent, id).uses.connection, undefined, "no connection id embedded in the node");
  }
  assert.equal(node(sent, "import_start").with, undefined, "manual start carries no channelId");
  assert.equal(node(sent, "import_start").uses.trigger, undefined);
  assert.equal(node(sent, "channel_changed").with.channelId, "ch_X");
  assert.equal(node(sent, "ev_target").with.input.expected.channelId.$, "vars.channelId", "ownership labels stay variable refs");
  assert.strictEqual(node(sent, "import_pages").with.maxPages, 10);
  assert.equal("companyId" in node(sent, "ev_snapshot").with, false, "companyId is the action's hidden const");
  assert.deepEqual(node(sent, "ev_target").with.input.connectionId, { $: "steps.import_conn.meta.connectionId" });
  // the source file stays unbound
  assert.equal(load().connections.flite.connection, null);
  assert.equal(load().connections.cohost.connection, null);
});
