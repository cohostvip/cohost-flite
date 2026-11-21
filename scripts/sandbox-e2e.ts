// Sandbox E2E harness shell (T3). Dry-run unless --apply. No environment-variable reads; secrets only from files.
//   node scripts/sandbox-e2e.ts setup|matrix [--rows R1,R2] --token-file <p> [--apply]
//     [--w6w <url>] [--cohost-api <url>] [--out <artifacts/e2e dir>] [--auth-emulator <url>]
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSandbox, sandboxAuthKey } from "./sandbox-guard.ts";

export const ROWS = Array.from({ length: 13 }, (_, i) => `R${i + 1}`);
const USAGE = `usage: sandbox-e2e.ts setup|matrix [--rows R1,R2..] --token-file <path> [--apply]
  [--w6w <url>] [--cohost-api <url>] [--out <dir>] [--auth-emulator <url>]
Dry-run by default; mutating calls need --apply. Flite requests are sandbox-only (assertSandbox).
Credentials are read from files only; --token/--password flags are rejected.`;

export interface Opts { cmd: string; rows: string[]; apply: boolean; flags: Record<string, string> }

export function parseArgs(argv: string[]): Opts {
  const flags: Record<string, string> = {};
  let cmd = "", apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (/^--(token|password|pwd|uname)(=|$)/.test(a)) throw new Error(`${a.split("=")[0]} is rejected; secrets come from files (--token-file)`);
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else if (!cmd) cmd = a;
  }
  const rows = flags.rows ? flags.rows.split(",").map((s) => s.trim()) : ROWS;
  for (const r of rows) if (!ROWS.includes(r)) throw new Error(`unknown row ${r}`);
  return { cmd, rows, apply, flags };
}

export class Harness {
  readonly out: string;
  readonly o: Opts;
  constructor(o: Opts) {
    this.o = o;
    this.out = o.flags.out ?? "artifacts/e2e";
  }
  get w6w() { return this.o.flags.w6w ?? "http://localhost:3000/api"; }
  get cohostApi() { return this.o.flags["cohost-api"] ?? "http://localhost:5999/api/v1"; }
  private token(): string {
    const f = this.o.flags["token-file"];
    if (!f) throw new Error("--token-file required");
    const raw = readFileSync(f, "utf8").trim();
    try { const j = JSON.parse(raw); return j.token ?? raw; } catch { return raw; }
  }
  private async http(url: string, method: string, bearer: string, body?: unknown): Promise<any> {
    if (method !== "GET" && !this.o.apply) return { dryRun: true, method, url };
    const res = await fetch(url, { method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
      const code = typeof parsed?.error?.code === "string" && /^[a-z_]{1,64}$/.test(parsed.error.code) ? ` ${parsed.error.code}` : "";
      throw Object.assign(new Error(`${method} ${new URL(url).pathname} -> ${res.status}${code}`), { status: res.status });
    }
    return parsed;
  }
  /** W REST via the token file. */
  w6wReq(method: string, path: string, body?: unknown) { return this.http(`${this.w6w}${path}`, method, this.token(), body); }
  /** slot-2 Cohost API with an emulator bearer (obtained by signInWithPassword; password read from --cohost-cred-file). */
  async cohostBearer(): Promise<string> {
    const emu = this.o.flags["auth-emulator"] ?? "http://localhost:9039";
    const cred = this.o.flags["cohost-cred-file"];
    if (!cred) throw new Error("--cohost-cred-file <json {email,password}> required");
    const { email, password } = JSON.parse(readFileSync(cred, "utf8"));
    const r = await fetch(`${emu}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=local`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
    const b: any = await r.json();
    if (!b.idToken) throw new Error("auth emulator sign-in failed");
    return b.idToken;
  }
  async cohostReq(method: string, path: string, body?: unknown) { return this.http(`${this.cohostApi}${path}`, method, await this.cohostBearer(), body); }

  /** Flite call: assertSandbox first; logs `METHOD url` only (no body/headers). */
  async fliteReq(method: string, url: string, headers: Record<string, string> = {}, body?: unknown): Promise<any> {
    assertSandbox(url);
    mkdirSync(this.out, { recursive: true });
    appendFileSync(join(this.out, "flite-requests.log"), `${method} ${url}\n`);
    if (method !== "GET" && !this.o.apply) return { dryRun: true, method, url };
    const res = await fetch(url, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`flite ${method} ${new URL(url).pathname} -> ${res.status}`);
    try { return JSON.parse(text); } catch { return text; }
  }
  fliteGet(url: string, headers?: Record<string, string>) { return this.fliteReq("GET", url, headers); }
  flitePost(url: string, body: unknown, headers?: Record<string, string>) { return this.fliteReq("POST", url, headers, body); }

  /** Matrix recorder: `expected` is persisted BEFORE the step runs. */
  async record(row: string, expected: string, step: () => Promise<{ observed: string; pass: boolean; runIds?: string[]; fliteReadback?: unknown; recorded?: boolean }>) {
    const file = join(this.out, "matrix.json");
    mkdirSync(this.out, { recursive: true });
    const load = (): any[] => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
    const put = (r: any) => writeFileSync(file, JSON.stringify([...load().filter((x) => x.row !== row), r].sort((a, b) => a.row.localeCompare(b.row, "en", { numeric: true })), null, 2));
    put({ row, expected, observed: null, status: "PENDING", runIds: [], fliteReadback: null });
    try {
      const r = await step();
      put({ row, expected, observed: r.observed, status: r.recorded ? "RECORDED" : r.pass ? "PASS" : "FAIL", runIds: r.runIds ?? [], fliteReadback: r.fliteReadback ?? null });
    } catch (e) {
      put({ row, expected, observed: `error: ${(e as Error).message}`, status: "ERROR", runIds: [], fliteReadback: null });
    }
  }
}


const PREFIX = "fsc-e2e-";
const WF_ID = "wf_flite-sales-channel";
const WF_FILE = "workflows/flite-sales-channel.workflow.json";
const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Parse KEY=value lines (no shell, no env); returns only the requested keys. */
export function parseEnvFile(file: string, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !keys.includes(m[1])) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const idOf = (r: any): string | undefined => r?.id ?? r?.data?.id ?? r?.connection?.id ?? r?.channel?.id ?? r?.data?.channel?.id ?? r?.data?.connection?.id;
const list = (r: any, key: string): any[] => (Array.isArray(r) ? r : r?.[key] ?? r?.data?.[key] ?? r?.results ?? r?.data ?? []);

/** setup: connections, slot-2 channel, workflow install + publish, subscription check. Idempotent by `fsc-e2e-*` names. */
export async function setup(h: Harness): Promise<number> {
  const log = (m: string) => console.log(m);
  const state: Record<string, unknown> = { startedAt: new Date().toISOString(), apply: h.o.apply };
  const save = () => { mkdirSync(h.out, { recursive: true }); writeFileSync(join(h.out, "setup.json"), JSON.stringify(state, null, 2) + "\n"); };
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

  // (a) Flite SANDBOX connection (credentials parsed from the env file; only ever in the POST body)
  const envFile = h.o.flags["flite-env-file"] ?? "/home/segevs/orca/workspaces/cohost/integrations-flite/oss/flite/.env.local";
  const existing = list(await h.w6wReq("GET", "/connections"), "connections");
  let flite = existing.find((c) => c.appId === "vip.cohost.flite" && String(c.displayName).startsWith(PREFIX));
  let fliteOrg = "sandbox";
  if (!flite) {
    const c = parseEnvFile(envFile, ["FLITE_SANDBOX_UNAME", "FLITE_SANDBOX_PWD"]);
    if (!c.FLITE_SANDBOX_UNAME || !c.FLITE_SANDBOX_PWD) throw new Error("FLITE_SANDBOX_UNAME/PWD not found in the env file");
    sandboxAuthKey("partner-login-staging");
    const r = await h.w6wReq("POST", "/apps/vip.cohost.flite/connections", { authKey: "partner-login-staging", displayName: `${PREFIX}flite-${ts}`, credential: { email: c.FLITE_SANDBOX_UNAME, password: c.FLITE_SANDBOX_PWD } });
    if (r?.dryRun) log("dry-run: would create Flite sandbox connection"); else { flite = r.connection ?? r.data ?? r; fliteOrg = String(r?.profile?.organization ?? flite?.profile?.organization ?? fliteOrg); }
  } else { log(`reuse Flite connection ${flite.id}`); fliteOrg = String(flite.profile?.organization ?? fliteOrg); }
  if (flite?.id) {
    const fresh = list(await h.w6wReq("GET", "/connections"), "connections").find((c) => c.id === flite.id) ?? flite;
    sandboxAuthKey(String(fresh.authKey ?? flite.authKey)); // throws unless *-staging
    const t = await h.w6wReq("POST", `/connections/${flite.id}/test`, {});
    const after = list(await h.w6wReq("GET", "/connections"), "connections").find((c) => c.id === flite.id) ?? fresh;
    state.flite = { connectionId: flite.id, authKey: fresh.authKey ?? flite.authKey, state: after.state, testOk: t?.ok ?? after.lastTestOk ?? null, organization: fliteOrg };
    if (after.state !== "connected") { save(); throw new Error(`Flite connection state ${after.state}`); }
  }
  state.org = fliteOrg;

  // (b) slot-2 Cohost connection (api-token auth; token = slot-2 emulator bearer, body-only)
  let cohost = existing.find((c) => c.appId === "vip.cohost.w6w" && String(c.displayName).startsWith(PREFIX));
  if (!cohost) {
    if (h.o.apply) {
      const r = await h.w6wReq("POST", "/apps/vip.cohost.w6w/connections", { authKey: "api-token", displayName: `${PREFIX}cohost-slot2-${ts}`, credential: { token: await h.cohostBearer() } });
      cohost = r.connection ?? r.data ?? r;
    } else log("dry-run: would create slot-2 Cohost connection");
  } else log(`reuse Cohost connection ${cohost.id}`);
  if (cohost?.id) {
    const t = await h.w6wReq("POST", `/connections/${cohost.id}/test`, {});
    const after = list(await h.w6wReq("GET", "/connections"), "connections").find((c) => c.id === cohost.id) ?? cohost;
    state.cohost = { connectionId: cohost.id, authKey: after.authKey ?? cohost.authKey, state: after.state, testOk: t?.ok ?? after.lastTestOk ?? null };
    if (after.state !== "connected") { save(); throw new Error(`Cohost connection state ${after.state}`); }
  }

  // (c) slot-2 channel: company-owned, type api, not public
  const chans = list(await h.cohostReq("GET", "/company/sales-channels"), "channels");
  let channel = chans.find((c) => String(c.name ?? "").startsWith(PREFIX));
  if (!channel) {
    const r = await h.cohostReq("POST", "/company/sales-channels", { channel: { name: `${PREFIX}${ts}`, type: "api", isPublic: false } });
    if (r?.dryRun) log("dry-run: would create slot-2 channel"); else channel = r.channel ?? r.data ?? r;
  } else log(`reuse channel ${channel.id}`);
  const channelId = idOf(channel);
  if (channelId) state.channel = { channelId, name: channel.name ?? `${PREFIX}${ts}`, type: channel.type ?? "api", isPublic: channel.isPublic ?? false };
  save();
  if (!flite?.id || !cohost?.id || !channelId) { log("dry-run complete (nothing mutated); setup.json written"); return 0; }

  // (d) install + publish via T1's workflow.ts (argv carries only ids and paths)
  const wfArgs = ["--w6w", h.w6w, "--token-file", h.o.flags["token-file"], "--var", "env=sandbox", "--var", `channelId=${channelId}`, "--var", `org=${fliteOrg}`, "--connection", `cohost=${cohost.id}`, "--connection", `flite=${flite.id}`, "--apply"];
  const wf = (cmd: string) => execFileSync(process.execPath, [join(SCRIPT_DIR, "workflow.ts"), cmd, join(SCRIPT_DIR, "..", WF_FILE), ...wfArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let wfExists = false;
  try { await h.w6wReq("GET", `/workflows/${WF_ID}`); wfExists = true; } catch (e) { if ((e as any).status !== 404) throw e; }
  if (!wfExists) log(wf("install").trim()); else log(`workflow ${WF_ID} already installed`);
  log(wf("publish").trim());
  state.workflow = { id: WF_ID, installed: true, vars: { env: "sandbox", channelId, org: fliteOrg } };

  // (e) exactly 2 active subscriptions, bounded retry (<= 90 s)
  let subs: any[] = [];
  const deadline = Date.now() + 90_000;
  const active = (x: any) => x.active === true || ["active", "enabled", "subscribed", "healthy", "live"].includes(String(x.status ?? x.state ?? "").toLowerCase());
  for (;;) {
    subs = list(await h.w6wReq("GET", `/workflows/${WF_ID}/subscriptions`), "subscriptions");
    if (subs.length >= 2 && subs.filter(active).length === 2 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  state.subscriptions = subs.map((x) => ({ id: x.id ?? x.subscriptionId, trigger: x.nodeId ?? x.trigger ?? x.triggerKey ?? x.action, status: x.status ?? x.state ?? x.active }));
  state.subscriptionsActive = subs.filter(active).length;
  state.finishedAt = new Date().toISOString();
  save();
  log(`subscriptions: ${subs.length} total, ${subs.filter(active).length} active`);
  if (subs.length !== 2 || subs.filter(active).length !== 2) { log("FAIL: expected exactly 2 active subscriptions; see setup.json"); return 2; }
  log("setup ok -> " + join(h.out, "setup.json"));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) { console.log(USAGE); return 0; }
  let o: Opts;
  try { o = parseArgs(argv); } catch (e) { console.error((e as Error).message); return 1; }
  if (o.cmd !== "setup" && o.cmd !== "matrix") { console.error(USAGE); return 1; }
  const h = new Harness(o);
  console.log(`${o.cmd}: ${o.apply ? "APPLY" : "dry-run"} w6w=${h.w6w} cohost=${h.cohostApi} rows=${o.rows.join(",")}`);
  if (o.cmd === "setup") return await setup(h);
  // TODO(T3 later slices): matrix = per-row steps via h.record(row, expected, step).
  console.log("stub: matrix not implemented yet");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
