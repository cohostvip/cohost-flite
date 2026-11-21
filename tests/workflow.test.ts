import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
