import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, validateWorkflow } from "../scripts/workflow.ts";

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
    wf.nodes = wf.nodes.filter((n: any) => n.id !== "ticket_changed");
    wf.edges = wf.edges.filter((e: any) => e.from !== "ticket_changed");
  }, /two trigger nodes/],
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
