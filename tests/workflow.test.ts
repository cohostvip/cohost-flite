import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateWorkflow } from "../scripts/workflow.ts";

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
  assert.match(String(dry.stdout), /^POST http:\/\/127\.0\.0\.1:1\/projects\/p\/workflows/);
  assert.match(String(dry.stdout), /dry run/);
});

const run = (...a: string[]) => spawnSync("node", ["scripts/workflow.ts", ...a]);

test("missing --w6w / --project / --token-file is refused", () => {
  const full = ["--w6w", "http://127.0.0.1:9", "--project", "p", "--token-file", "/dev/null"];
  for (const drop of ["--w6w", "--project", "--token-file"]) {
    const i = full.indexOf(drop);
    const args = full.filter((_, j) => j !== i && j !== i + 1);
    for (const cmd of ["install", "publish", "status"]) {
      const r = run(cmd, FILE, ...args);
      assert.notEqual(r.status, 0, `${cmd} without ${drop}`);
      assert.match(String(r.stderr), /needs --w6w/);
    }
  }
});

test("--token with a reachable server: nonzero and no request", async () => {
  const hits: string[] = [];
  const srv = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.end("{}"); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as any).port}`;
  const r = spawnSync("node", ["scripts/workflow.ts", "install", FILE, "--token", "sekret", "--w6w", url, "--project", "p", "--apply"]);
  srv.close();
  assert.notEqual(r.status, 0);
  assert.deepEqual(hits, []);
  assert.ok(!String(r.stdout).includes("sekret") && !String(r.stderr).includes("sekret"));
});

test("dry run makes no request; --apply sends once with bearer from file, token never printed", async () => {
  const hits = [] as Array<{ m?: string; u?: string; auth?: string; body: string }>;
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { hits.push({ m: req.method, u: req.url, auth: req.headers.authorization, body }); res.end("{}"); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as any).port}`;
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  const tf = join(dir, "tok");
  writeFileSync(tf, "s3cr3t-token\n");
  const base = ["--w6w", url, "--project", "p", "--token-file", tf];
  const exec = (...a: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn("node", ["scripts/workflow.ts", ...a]);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out }));
  });
  for (const cmd of ["install", "publish"]) {
    const dry = await exec(cmd, FILE, ...base, "--var", "env=sandbox");
    assert.equal(dry.code, 0);
    assert.match(dry.out, /^POST /);
  }
  assert.equal(hits.length as number, 0, "no request without --apply");
  const pub = await exec("publish", FILE, ...base, "--apply");
  assert.equal(pub.code, 0);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].m, "POST");
  assert.match(hits[0].u!, /^\/projects\/p\/workflows\/.+\/publish$/);
  assert.equal(hits[0].auth, "Bearer s3cr3t-token");
  assert.ok(!pub.out.includes("s3cr3t-token"));
  srv.close();
});

test("no process.env in the script and no credentials in the JSON", () => {
  assert.ok(!/process\.env/.test(readFileSync("scripts/workflow.ts", "utf8").replace(/^\/\/.*$/gm, "")));
  assert.ok(!/(bearer|secret|token"\s*:|apiKey|password)/i.test(readFileSync(FILE, "utf8")));
});
