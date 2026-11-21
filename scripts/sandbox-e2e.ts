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
  get w6w() { return this.o.flags.w6w ?? "https://api-s2.w6w.dev"; }
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
    const cred = this.o.flags["cohost-cred-file"] ?? "/tmp/fsc-t3-cohost-cred.json";
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
    state.cohost = { connectionId: cohost.id, authKey: after.authKey ?? cohost.authKey, state: after.state, testOk: t?.ok ?? after.lastTestOk ?? null, ...(t?.ok === false ? { testMessage: String(t.message ?? "").slice(0, 120), testNote: "api-token test reads /orders?limit=1; the emulator user gets 403 there while company routes answer 200" } : {}) };
    if (after.state !== "connected") { save(); throw new Error(`Cohost connection state ${after.state}`); }
  }

  // (c) slot-2 channel: company-owned, type api, not public
  const chans = list(await h.cohostReq("GET", "/company/sales-channels"), "channels");
  let channel = chans.find((c) => String(c.name ?? "").startsWith(PREFIX));
  if (!channel) {
    const r = await h.cohostReq("POST", "/company/sales-channels", { channel: { name: `${PREFIX}${ts}`, type: "api", isPublic: false, tags: [], filters: { tags: [], excludeContextId: [], includeContextId: [] } } });
    if (r?.dryRun) log("dry-run: would create slot-2 channel"); else channel = r.channel ?? r.data ?? r;
  } else log(`reuse channel ${channel.id}`);
  const channelId = idOf(channel);
  if (channelId) state.channel = { channelId, name: channel.name ?? `${PREFIX}${ts}`, type: channel.type ?? "api", isPublic: channel.isPublic ?? false };
  save();
  if (!flite?.id || !cohost?.id || !channelId) { log("dry-run complete (nothing mutated); setup.json written"); return 0; }

  // (d) install + publish via T1's workflow.ts (argv carries only ids and paths)
  // The engine stores trigger `with` unresolved (`{"$":"vars.channelId"}` reached the T2 trigger as an object and its
  // channel filter was skipped), so the install file binds the channel trigger's channelId as a literal.
  const wfJson = JSON.parse(readFileSync(join(SCRIPT_DIR, "..", WF_FILE), "utf8"));
  const chTrigger = wfJson.nodes.find((n: any) => n.uses?.trigger === true && n.uses.action === "channel-event-changed");
  if (!chTrigger?.with || chTrigger.with.channelId === undefined) throw new Error("channel-event-changed trigger has no channelId param to bind");
  chTrigger.with.channelId = channelId;
  const installFile = join(h.out, "workflow.installed.json");
  writeFileSync(installFile, JSON.stringify(wfJson, null, 2) + "\n");
  const wfArgs = ["--w6w", h.w6w, "--token-file", h.o.flags["token-file"], "--var", "env=sandbox", "--var", `channelId=${channelId}`, "--var", `org=${fliteOrg}`, "--connection", `cohost=${cohost.id}`, "--connection", `flite=${flite.id}`, "--apply"];
  const wf = (cmd: string) => execFileSync(process.execPath, [join(SCRIPT_DIR, "workflow.ts"), cmd, installFile, ...wfArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  log(wf("install").trim()); // POST /workflows on an existing id answers 201 (replaces the definition)
  log(wf("publish").trim());
  state.workflow = { id: WF_ID, installed: true, vars: { env: "sandbox", channelId, org: fliteOrg } };

  // (e) exactly 2 active subscriptions, bounded retry (<= 90 s)
  let subs: any[] = [];
  const deadline = Date.now() + 90_000;
  const active = (x: any) => x.enabled === true && ["registered", "active"].includes(String(x.status).toLowerCase()) && !x.lastError;
  for (;;) {
    subs = list(await h.w6wReq("GET", `/workflows/${WF_ID}/subscriptions`), "subscriptions");
    if (subs.length >= 2 && subs.filter(active).length === 2 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  state.subscriptions = subs.map((x) => ({ id: x.id ?? x.subscriptionId, trigger: x.nodeId, status: x.status, enabled: x.enabled, triggerKey: x.triggerKey, params: x.params }));
  state.subscriptionsActive = subs.filter(active).length;
  state.finishedAt = new Date().toISOString();
  save();
  log(`subscriptions: ${subs.length} total, ${subs.filter(active).length} active`);
  if (subs.length !== 2 || subs.filter(active).length !== 2) { log("FAIL: expected exactly 2 active subscriptions; see setup.json"); return 2; }
  log("setup ok -> " + join(h.out, "setup.json"));
  return 0;
}

// ---------------------------------------------------------------------------------------------
// matrix: scenario helpers (slot-2 Cohost API, w6w runs, Flite staging readback) + the rows
// ---------------------------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rid = () => Math.random().toString(36).slice(2, 10);
const FLITE_STAGING = "https://api-staging.fliteapi.city/api";

export interface Scenario { tag: string; eventId: string; name: string; tickets: Array<{ id: string; name: string; cost: number; capacity: number }>; channelId: string }

export class Matrix {
  readonly h: Harness;
  readonly setup: any;
  private fliteToken?: string;
  readonly tag: string;
  constructor(h: Harness) {
    this.h = h;
    this.setup = JSON.parse(readFileSync(join(h.out, "setup.json"), "utf8"));
    this.tag = `fsc-e2e-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  }
  get channelId(): string { return this.setup.channel.channelId; }
  subId(trigger: "channel_changed" | "ticket_changed"): string {
    const s = (this.setup.subscriptions as any[]).find((x) => x.trigger === trigger);
    if (!s?.id) throw new Error(`setup.json has no ${trigger} subscription`);
    return s.id;
  }

  /** Create a live company event + tickets, then list it on the slot-2 channel (PUT /events/:id/channels/:channelId). */
  async createScenario(label: string, tickets: Array<{ name: string; cost: number; capacity: number }>, opts: { list?: boolean } = {}): Promise<Scenario> {
    const name = `${this.tag}-${label}`;
    const day = 20 + Math.floor(Math.random() * 9);
    const ev = await this.h.cohostReq("POST", "/events", { event: {
      name, start: `2027-01-${day}T19:00:00.000Z`, end: `2027-01-${day}T22:00:00.000Z`, tz: "America/New_York", status: "live", currency: "USD", public: false,
      url: `${this.tag.toLowerCase()}-${label}-${rid()}`.slice(0, 60),
      location: { name: "Probe Hall", address: { city: "New York", region: "NY", country: "US", address_1: "1 Main St", postal_code: "10001" }, placeId: "fsc-e2e-place", venueId: "fsc-e2e-venue", geometry: null },
      description: { text: `${this.tag} ${label}` },
    } });
    const eventId = ev?.data?.id as string;
    if (!eventId) throw new Error(`event create returned no id (${JSON.stringify(ev).slice(0, 120)})`);
    const made: Scenario["tickets"] = [];
    for (const t of tickets) {
      const r = await this.h.cohostReq("POST", `/events/${eventId}/tickets`, { ticket: { name: t.name, type: "admission", category: "general", priceCategory: "paid", capacity: t.capacity, maximumQuantity: 10, costs: { cost: `USD,${t.cost}` }, status: "live" } });
      const id = Object.keys(r?.data?.ids ?? {})[0] ?? r?.data?.tickets?.[0]?.id;
      if (!id) throw new Error("ticket create returned no id");
      made.push({ id, name: t.name, cost: t.cost, capacity: t.capacity });
    }
    if (opts.list !== false) await this.h.cohostReq("PUT", `/events/${eventId}/channels/${this.channelId}`, {});
    return { tag: this.tag, eventId, name, tickets: made, channelId: this.channelId };
  }

  /** Cohost's webhook dispatcher does not run in slot-2: deliver the ping it would send, to the workflow's trigger URL. */
  async ping(trigger: "channel_changed" | "ticket_changed", action: string, resourcePath: string, data?: Record<string, unknown>): Promise<string> {
    const id = `trg_fsc${rid()}`;
    const body = { id, action, timestamp: new Date().toISOString(), urn: `urn:1:acme-corp:cohost-falcon:${resourcePath}`, context: { companyId: "acme-corp", service: "cohost-falcon", resourcePath }, ...(data ? { data } : {}) };
    if (!this.h.o.apply) return id;
    const res = await fetch(`${this.h.w6w}/triggers/webhooks/${this.subId(trigger)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`webhook delivery -> ${res.status}`);
    return id;
  }
  pingListing(eventId: string, action: "channelEvent.listed" | "channelEvent.changed" | "channelEvent.unlisted" = "channelEvent.listed") {
    return this.ping("channel_changed", action, `/channels/${this.channelId}/events/${eventId}/listings/primary`);
  }

  async runIds(): Promise<string[]> {
    const r = await this.h.w6wReq("GET", `/workflows/${WF_ID}/runs?limit=100`);
    return (list(r, "runs") as any[]).map((x) => x.runId);
  }
  /** Wait (bounded) until `count` NEW runs exist (not in `before`) and all are finished; returns their details. */
  async waitRuns(before: string[], count = 1, timeoutMs = 120_000): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const now = (await this.runIds()).filter((x) => !before.includes(x));
      if (now.length >= count) {
        const runs = await Promise.all(now.map(async (id) => (await this.h.w6wReq("GET", `/runs/${id}`)).run));
        if (runs.every((r) => !["queued", "running", "pending"].includes(String(r.status)))) return runs;
      }
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${count} new run(s); saw ${now.length}`);
      await sleep(2500);
    }
  }
  syncOut(run: any): any { return run?.nodes?.sync?.output ?? null; }

  // --- Flite staging readback (credentials only in the login body; every call is assertSandbox-ed + logged) ---
  private async fliteAuth(): Promise<Record<string, string>> {
    if (!this.fliteToken) {
      const envFile = this.h.o.flags["flite-env-file"] ?? "/home/segevs/orca/workspaces/cohost/integrations-flite/oss/flite/.env.local";
      const c = parseEnvFile(envFile, ["FLITE_SANDBOX_UNAME", "FLITE_SANDBOX_PWD"]);
      const r = await this.h.flitePost(`${FLITE_STAGING}/partner-login`, { email: c.FLITE_SANDBOX_UNAME, password: c.FLITE_SANDBOX_PWD });
      this.fliteToken = r?.data?.token;
      if (!this.fliteToken) throw new Error("Flite staging login returned no token");
    }
    return { authorization: `Bearer ${this.fliteToken}` };
  }
  async fliteEvent(fliteEventId: string): Promise<any> {
    const r = await this.h.fliteGet(`${FLITE_STAGING}/get-event-tickets-info?eventId=${encodeURIComponent(fliteEventId)}`, await this.fliteAuth());
    return r?.data;
  }
  /** Number of Flite staging events whose name is exactly `name` (get-events-all?search=). */
  async fliteCount(name: string): Promise<number> {
    const r = await this.h.fliteGet(`${FLITE_STAGING}/get-events-all?page=1&limit=50&search=${encodeURIComponent(name)}`, await this.fliteAuth());
    return ((r?.data ?? []) as any[]).filter((e) => (e.eventName ?? e.name) === name).length;
  }
  /** Fire one channel ping for the scenario's listing and wait for its single run. */
  async cycle(eventId: string, action: "channelEvent.listed" | "channelEvent.changed" | "channelEvent.unlisted" = "channelEvent.changed"): Promise<{ run: any; out: any }> {
    const before = await this.runIds();
    await this.pingListing(eventId, action);
    const run = (await this.waitRuns(before, 1))[0];
    return { run, out: this.syncOut(run) };
  }
  /** The Cohost system resource a Flite URN maps to (RMS), or null. */
  async mappingFor(mappedUrn: string): Promise<any | null> {
    try {
      const r = await this.h.cohostReq("POST", "/rms/urn/resolve", { urn: mappedUrn });
      return (r?.resources ?? r?.data?.resources ?? []).find((x: any) => x["-resource.@type"] === "system-resource") ?? null;
    } catch { return null; }
  }
}

const compact = (e: any) => e && ({ _id: e._id, eventName: e.eventName, isEventEnd: e.isEventEnd, tickets: (e.tickets ?? []).map((t: any) => ({ _id: t._id, ticketName: t.ticketName, ticketPrice: t.ticketPrice, capacity: t.capacity, sold: t.sold, availability: t.availability })) });

type RowFn = (m: Matrix) => Promise<{ expected: string; step: () => Promise<{ observed: string; pass: boolean; runIds?: string[]; fliteReadback?: unknown; recorded?: boolean }> }>;

/** R1 first publish: 1 Flite event; its tickets = the channel tickets; RMS mapping present. */
const R1: RowFn = async (m) => {
  const sc = await m.createScenario("r1", [{ name: "GA", cost: 1000, capacity: 50 }, { name: "VIP", cost: 2500, capacity: 20 }]);
  return {
    expected: `${sc.name}: first publish creates exactly 1 Flite staging event named ${sc.name}; it has ${sc.tickets.length} tickets (GA 10.00, VIP 25.00) = the channel tickets; sync output env=sandbox, no errors; the event URN is RMS-mapped`,
    step: async () => {
      const before = await m.runIds();
      await m.pingListing(sc.eventId);
      const runs = await m.waitRuns(before, 1);
      const out = m.syncOut(runs[0]);
      const problems: string[] = [];
      if (runs[0].status !== "succeeded") problems.push(`run status ${runs[0].status}`);
      if (out?.env !== "sandbox") problems.push(`env=${out?.env}`);
      if (out?.errors?.length) problems.push(`errors=${JSON.stringify(out.errors)}`);
      const reg = (out?.registrations ?? []) as any[];
      const evReg = reg.find((r) => r.labels?.kind === "event");
      const fliteId: string = out?.eventId ?? "";
      let readback: any = null; let mapping: any = null;
      if (fliteId) {
        readback = compact(await m.fliteEvent(fliteId));
        if (readback.eventName !== sc.name) problems.push(`eventName=${readback.eventName}`);
        if (readback.tickets.length !== sc.tickets.length) problems.push(`flite tickets=${readback.tickets.length}`);
        const prices = readback.tickets.map((t: any) => Number(t.ticketPrice)).sort((a: number, b: number) => a - b).join(",");
        if (prices !== "10,25") problems.push(`prices=${prices}`);
        if (reg.filter((r) => r.labels?.kind === "ticket").length !== sc.tickets.length) problems.push("ticket registrations missing");
        mapping = evReg ? await m.mappingFor(evReg.mappedUrn) : null;
        if (!mapping) problems.push("RMS mapping not found for the event mappedUrn");
      } else problems.push("sync output has no eventId");
      return { observed: problems.length ? problems.join("; ") : `1 Flite event ${fliteId}, ${readback.tickets.length} tickets, env=sandbox, mapping ${mapping?.["-resource.id"] ?? "present"}`, pass: problems.length === 0, runIds: runs.map((r) => r.runId), fliteReadback: { eventId: fliteId, ...readback, scenario: { cohostEventId: sc.eventId, tickets: sc.tickets } } };
    },
  };
};


// ---- shared row plumbing ----
type Step = { observed: string; pass: boolean; runIds?: string[]; fliteReadback?: unknown; recorded?: boolean };
const okRun = (run: any, out: any, p: string[], tag: string) => {
  if (run.status !== "succeeded") p.push(`${tag}: run status ${run.status}`);
  if (out?.env !== "sandbox") p.push(`${tag}: env=${out?.env}`);
  if (out?.errors?.length) p.push(`${tag}: errors=${JSON.stringify(out.errors)}`);
};
const ops = (out: any): string[] => ((out?.operations ?? []) as any[]).map((o) => o.op);
const SYNTH = "triggers fired by synthetic ping (slot-2 has no webhook dispatcher)";
const TWO = [{ name: "GA", cost: 1000, capacity: 50 }, { name: "VIP", cost: 2500, capacity: 20 }];
const done = (p: string[], ok: string, runIds: string[], fliteReadback: unknown, extra: Partial<Step> = {}): Step => ({ observed: p.length ? p.join("; ") : ok, pass: p.length === 0, runIds, fliteReadback, ...extra });

/** First publish used as setup by R2/R4/R5/R6 (must itself succeed; failures surface as problems of the row). */
async function firstPublish(m: Matrix, sc: Scenario, p: string[]) {
  const { run, out } = await m.cycle(sc.eventId, "channelEvent.listed");
  okRun(run, out, p, "first publish");
  const fliteId: string = out?.eventId ?? "";
  const evReg = ((out?.registrations ?? []) as any[]).find((r) => r.labels?.kind === "event");
  const remote = fliteId ? compact(await m.fliteEvent(fliteId)) : null;
  return { run, out, fliteId, evReg, remote, ticketIds: (remote?.tickets ?? []).map((t: any) => t._id).sort() as string[] };
}

/** R2 duplicate delivery: a second ping for the same listing changes nothing remote. */
const R2: RowFn = async (m) => {
  const sc = await m.createScenario("r2", TWO);
  return {
    expected: `${sc.name}: after the first publish, a duplicate delivery of the same channel ping makes a second run that succeeds with env=sandbox, no create operations, the same Flite event id and ticket ids, and exactly 1 Flite staging event with that name; ${SYNTH}`,
    step: async () => {
      const p: string[] = [];
      const f = await firstPublish(m, sc, p);
      const dup = await m.cycle(sc.eventId, "channelEvent.listed");
      okRun(dup.run, dup.out, p, "duplicate");
      if (dup.out?.eventId !== f.fliteId) p.push(`event id changed ${f.fliteId} -> ${dup.out?.eventId}`);
      const bad = ops(dup.out).filter((o) => o.startsWith("create"));
      if (bad.length) p.push(`duplicate run created: ${bad.join(",")}`);
      const after = dup.out?.eventId ? compact(await m.fliteEvent(dup.out.eventId)) : null;
      if (JSON.stringify(after?.tickets?.map((t: any) => t._id).sort()) !== JSON.stringify(f.ticketIds)) p.push("ticket ids changed");
      const count = await m.fliteCount(sc.name);
      if (count !== 1) p.push(`remote event count ${count}`);
      return done(p, `duplicate run ${dup.run.runId}: ops=[${ops(dup.out).join(",")}], same event ${f.fliteId}, same ${f.ticketIds.length} ticket ids, remote count ${count}, env=sandbox`, [f.run.runId, dup.run.runId], { eventId: f.fliteId, remoteCount: count, ...after });
    },
  };
};

/** R3 concurrent first publish: two simultaneous first pings; the remote count is recorded (>1 = residual race). */
const R3: RowFn = async (m) => {
  const sc = await m.createScenario("r3", TWO);
  return {
    expected: `${sc.name}: two first-publish pings fired concurrently; both runs finish; the number of Flite staging events named ${sc.name} is RECORDED (1 = PASS; >1 = documented residual race, status RECORDED); ${SYNTH}`,
    step: async () => {
      const before = await m.runIds();
      await Promise.all([m.pingListing(sc.eventId, "channelEvent.listed"), m.pingListing(sc.eventId, "channelEvent.listed")]);
      const runs = await m.waitRuns(before, 2);
      const outs = runs.map((r) => m.syncOut(r));
      const count = await m.fliteCount(sc.name);
      const ids = outs.map((o) => o?.eventId ?? "");
      const sts = runs.map((r) => r.status);
      return { observed: `remote event count ${count}; runs ${sts.join("/")}; event ids per run [${ids.join(", ")}]; ops [${outs.map((o) => ops(o).join("+")).join(" | ")}]; env [${outs.map((o) => o?.env).join(",")}]${count > 1 ? "; residual: concurrent first publishes are not serialised (no lock between mapping lookup and create)" : ""}`, pass: count === 1 && outs.every((o) => o?.env === "sandbox"), recorded: count > 1 && outs.every((o) => o?.env === "sandbox"), runIds: runs.map((r) => r.runId), fliteReadback: { remoteCount: count, eventIds: ids } };
    },
  };
};

const flip = (remote: any) => ({ ended: remote?.isEventEnd, avail: (remote?.tickets ?? []).map((t: any) => t.availability) });

/** Shared body of R4/R5: stop via `off`, reopen via `on`. */
function stopReopen(label: string, what: string, off: (m: Matrix, sc: Scenario) => Promise<"channelEvent.unlisted" | "channelEvent.changed">, on: (m: Matrix, sc: Scenario) => Promise<"channelEvent.listed" | "channelEvent.changed">): RowFn {
  return async (m) => {
    const sc = await m.createScenario(label, TWO);
    return {
      expected: `${sc.name}: after the first publish, ${what} => run succeeds env=sandbox, Flite event ended (isEventEnd true), every ticket availability "false", RMS event mapping kept, remote count 1; then the reverse => SAME Flite event id and ticket ids reopened (isEventEnd false, tickets "true"), remote count still 1; ${SYNTH}`,
      step: async () => {
        const p: string[] = [];
        const f = await firstPublish(m, sc, p);
        if (!f.fliteId) return done(["no Flite event after first publish", ...p], "", [f.run.runId], null);
        const offAction = await off(m, sc);
        const a = await m.cycle(sc.eventId, offAction);
        okRun(a.run, a.out, p, "stop");
        const ra = compact(await m.fliteEvent(f.fliteId));
        if (ra.isEventEnd !== true) p.push(`after stop isEventEnd=${ra.isEventEnd}`);
        if (ra.tickets.some((t: any) => t.availability !== "false")) p.push(`after stop ticket availability ${JSON.stringify(flip(ra).avail)}`);
        const mapKept = f.evReg ? await m.mappingFor(f.evReg.mappedUrn) : null;
        if (!mapKept) p.push("event mapping not found after stop");
        const c1 = await m.fliteCount(sc.name);
        if (c1 !== 1) p.push(`count after stop ${c1}`);
        const onAction = await on(m, sc);
        const b = await m.cycle(sc.eventId, onAction);
        okRun(b.run, b.out, p, "reopen");
        if (b.out?.eventId !== f.fliteId) p.push(`reopen event id ${b.out?.eventId} != ${f.fliteId}`);
        const rb = compact(await m.fliteEvent(f.fliteId));
        if (rb.isEventEnd === true) p.push("after reopen still ended");
        if (JSON.stringify(rb.tickets.map((t: any) => t._id).sort()) !== JSON.stringify(f.ticketIds)) p.push("ticket ids differ after reopen");
        if (rb.tickets.some((t: any) => t.availability !== "true")) p.push(`after reopen availability ${JSON.stringify(flip(rb).avail)}`);
        if (ops(b.out).some((o) => o.startsWith("create"))) p.push(`reopen created: ${ops(b.out).join(",")}`);
        const c2 = await m.fliteCount(sc.name);
        if (c2 !== 1) p.push(`count after reopen ${c2}`);
        return done(p, `stop run ${a.run.runId} ops=[${ops(a.out).join(",")}] -> ended=${ra.isEventEnd}, tickets ${JSON.stringify(flip(ra).avail)}, mapping kept (${mapKept?.["-resource.id"] ?? "found"}), count ${c1}; reopen run ${b.run.runId} ops=[${ops(b.out).join(",")}] -> same event ${f.fliteId}, same ticket ids, ended=${rb.isEventEnd}, tickets ${JSON.stringify(flip(rb).avail)}, count ${c2}; env=sandbox`, [f.run.runId, a.run.runId, b.run.runId], { eventId: f.fliteId, afterStop: ra, afterReopen: rb });
      },
    };
  };
}

const R4 = stopReopen("r4", "the event is removed (unlisted) from the channel",
  async (m, sc) => { await m.h.cohostReq("DELETE", `/events/${sc.eventId}/channels/${m.channelId}`); return "channelEvent.unlisted"; },
  async (m, sc) => { await m.h.cohostReq("PUT", `/events/${sc.eventId}/channels/${m.channelId}`, {}); return "channelEvent.listed"; });

const R5 = stopReopen("r5", "the channel listing is hidden",
  async (m, sc) => { await m.h.cohostReq("PATCH", `/company/sales-channels/${m.channelId}/events/${sc.eventId}/listing`, { visibility: "hidden" }); return "channelEvent.changed"; },
  async (m, sc) => { await m.h.cohostReq("PATCH", `/company/sales-channels/${m.channelId}/events/${sc.eventId}/listing`, { visibility: "visible" }); return "channelEvent.changed"; });

/** R6 owner status walk: draft -> live -> started (hold) -> ended -> canceled. */
const R6: RowFn = async (m) => {
  const sc = await m.createScenario("r6", TWO);
  return {
    expected: `${sc.name}: after the first publish the owner status walks draft (stop: ended, tickets "false") -> live (reopen, same ids) -> started (hold: stays active, isEventEnd false, tickets "true", D3) -> ended (stop) -> canceled (stop, no-op remote); each run succeeds env=sandbox, no create operations, remote count stays 1; ${SYNTH}`,
    step: async () => {
      const p: string[] = [];
      const f = await firstPublish(m, sc, p);
      if (!f.fliteId) return done(["no Flite event after first publish", ...p], "", [f.run.runId], null);
      const runIds = [f.run.runId]; const seen: string[] = []; const readbacks: Record<string, unknown> = {};
      const walk: Array<[string, boolean, "true" | "false"]> = [["draft", true, "false"], ["live", false, "true"], ["started", false, "true"], ["ended", true, "false"], ["canceled", true, "false"]];
      for (const [status, wantEnded, wantAvail] of walk) {
        try { await m.h.cohostReq("PATCH", `/events/${sc.eventId}`, { event: { status }, context: {} }); } catch (e) { p.push(`${status}: PATCH failed ${(e as Error).message}`); continue; }
        const r = await m.cycle(sc.eventId);
        runIds.push(r.run.runId);
        okRun(r.run, r.out, p, status);
        const rb = compact(await m.fliteEvent(f.fliteId));
        readbacks[status] = rb;
        if (Boolean(rb.isEventEnd) !== wantEnded) p.push(`${status}: isEventEnd=${rb.isEventEnd}, wanted ${wantEnded}`);
        if (rb.tickets.some((t: any) => t.availability !== wantAvail)) p.push(`${status}: availability ${JSON.stringify(flip(rb).avail)}, wanted ${wantAvail}`);
        if (ops(r.out).some((o) => o.startsWith("create"))) p.push(`${status}: created ${ops(r.out).join(",")}`);
        seen.push(`${status}[mode=${r.out?.mode} ops=${ops(r.out).join("+") || "-"} ended=${rb.isEventEnd}]`);
      }
      const c = await m.fliteCount(sc.name);
      if (c !== 1) p.push(`remote count ${c}`);
      return done(p, `${seen.join(" -> ")}; remote count ${c}; env=sandbox`, runIds, { eventId: f.fliteId, remoteCount: c, ...readbacks });
    },
  };
};

const ROW_FNS: Record<string, RowFn> = { R1, R2, R3, R4, R5, R6 };

export async function matrix(h: Harness): Promise<number> {
  if (!h.o.apply) { console.log("dry-run: matrix drives live slot-2 + Flite staging; pass --apply"); return 0; }
  const m = new Matrix(h);
  let failed = 0;
  for (const row of h.o.rows) {
    const fn = ROW_FNS[row];
    if (!fn) { console.log(`${row}: not implemented yet (skipped)`); continue; }
    try {
      const prepared = await fn(m); // creates the row's own tagged slot-2 records, then `expected` is persisted before the step runs
      await h.record(row, prepared.expected, prepared.step);
    } catch (e) {
      await h.record(row, "(row setup failed before any expectation)", async () => { throw e; });
    }
    const res = (JSON.parse(readFileSync(join(h.out, "matrix.json"), "utf8")) as any[]).find((x) => x.row === row);
    console.log(`${row}: ${res?.status} — ${String(res?.observed).slice(0, 200)}`);
    if (res?.status !== "PASS" && res?.status !== "RECORDED") failed++;
  }
  return failed ? 2 : 0;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) { console.log(USAGE); return 0; }
  let o: Opts;
  try { o = parseArgs(argv); } catch (e) { console.error((e as Error).message); return 1; }
  if (o.cmd !== "setup" && o.cmd !== "matrix") { console.error(USAGE); return 1; }
  const h = new Harness(o);
  console.log(`${o.cmd}: ${o.apply ? "APPLY" : "dry-run"} w6w=${h.w6w} cohost=${h.cohostApi} rows=${o.rows.join(",")}`);
  if (o.cmd === "setup") return await setup(h);
  return await matrix(h);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
