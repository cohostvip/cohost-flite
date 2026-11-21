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
  /** The channel's view of an event's tickets (GET /events/:id/tickets with x-cohost-channel-id): costs include channel pricing, status "unavailable" while sales are paused. */
  async channelTickets(eventId: string): Promise<Array<{ id: string; name: string; cost: string; status: string }>> {
    const r = await fetch(`${this.h.cohostApi}/events/${eventId}/tickets`, { headers: { authorization: `Bearer ${await this.h.cohostBearer()}`, "x-cohost-channel-id": this.channelId } });
    if (!r.ok) throw new Error(`GET channel tickets -> ${r.status}`);
    return (((await r.json()) as any).data as any[]).map((t) => ({ id: t.id, name: t.name, cost: t.costs?.cost, status: t.status }));
  }
  /** Merge `patch` into the listing's customization (PUT /events/:id/channels/:ch/customization), keeping what is there. */
  async customize(eventId: string, patch: (c: any) => any): Promise<void> {
    const cur = (await this.h.cohostReq("GET", `/events/${eventId}/channels/${this.channelId}/customization`))?.data?.customization ?? {};
    await this.h.cohostReq("PUT", `/events/${eventId}/channels/${this.channelId}/customization`, { customization: patch({ fees: [], ...cur }) });
  }
  /** The Cohost system resource a Flite URN maps to (RMS), or null. */
  async mappingFor(mappedUrn: string): Promise<any | null> {
    try {
      const r = await this.h.cohostReq("POST", "/rms/urn/resolve", { urn: mappedUrn });
      return (r?.resources ?? r?.data?.resources ?? []).find((x: any) => x["-resource.@type"] === "system-resource") ?? null;
    } catch { return null; }
  }
}

const compact = (e: any) => e && ({ _id: e._id, eventName: e.eventName, description: e.description, isEventEnd: e.isEventEnd, tickets: (e.tickets ?? []).map((t: any) => ({ _id: t._id, ticketName: t.ticketName, ticketPrice: t.ticketPrice, capacity: t.capacity, sold: t.sold, availability: t.availability })) });

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

/** R7 name + description change; also records what an empty owner description does. */
const R7: RowFn = async (m) => {
  const sc = await m.createScenario("r7", TWO);
  const newName = `${sc.name}-renamed`;
  const newDesc = `${m.tag} r7 changed description`;
  return {
    expected: `${sc.name}: after the first publish the owner renames the event to ${newName} and changes its description to "${newDesc}" => run succeeds env=sandbox with an update-event operation (no create), the Flite readback has eventName and description equal to the new values (description stored by Flite as <p>text</p>), same Flite event id, exactly 1 Flite event named ${newName}; then the owner description is emptied => the observed behaviour (Cohost reply, run ops/errors, Flite description) is RECORDED, not asserted; ${SYNTH}`,
    step: async () => {
      const p: string[] = [];
      const f = await firstPublish(m, sc, p);
      if (!f.fliteId) return done(["no Flite event after first publish", ...p], "", [f.run.runId], null);
      const desc0 = f.remote?.description;
      await m.h.cohostReq("PATCH", `/events/${sc.eventId}`, { event: { name: newName, description: { text: newDesc } }, context: {} });
      const a = await m.cycle(sc.eventId);
      okRun(a.run, a.out, p, "rename");
      if (a.out?.eventId !== f.fliteId) p.push(`event id ${f.fliteId} -> ${a.out?.eventId}`);
      if (!ops(a.out).includes("update-event")) p.push(`no update-event op: [${ops(a.out).join(",")}]`);
      if (ops(a.out).some((o) => o.startsWith("create"))) p.push(`rename created: ${ops(a.out).join(",")}`);
      const ra = compact(await m.fliteEvent(f.fliteId));
      if (ra.eventName !== newName) p.push(`eventName=${ra.eventName}`);
      if (String(ra.description ?? "").trim() !== `<p>${newDesc}</p>`) p.push(`description=${JSON.stringify(ra.description)}`); // Flite stores the text as <p>…</p> (the converter's textToHtml)
      const cNew = await m.fliteCount(newName);
      if (cNew !== 1) p.push(`count(${newName})=${cNew}`);
      // empty description: recorded only
      let emptyNote: string; const runIds = [f.run.runId, a.run.runId]; let rc: any = null;
      try {
        await m.h.cohostReq("PATCH", `/events/${sc.eventId}`, { event: { description: { text: "" } }, context: {} });
        const own: any = (await m.h.cohostReq("GET", `/events/${sc.eventId}`))?.data;
        const ownerDesc = JSON.stringify(own?.contentBlocks?.find((b: any) => b.designation === "description")?.data ?? own?.description ?? null);
        const e = await m.cycle(sc.eventId);
        runIds.push(e.run.runId);
        rc = compact(await m.fliteEvent(f.fliteId));
        emptyNote = `Cohost owner description after the empty PATCH ${ownerDesc}; run ${e.run.status} ops=[${ops(e.out).join(",")}] errors=${JSON.stringify(e.out?.errors ?? [])}; Flite description ${JSON.stringify(rc.description)} (was ${JSON.stringify(ra.description)})`;
      } catch (err) { emptyNote = `owner PATCH or run failed: ${(err as Error).message}`; }
      return done(p, `rename run ${a.run.runId} ops=[${ops(a.out).join(",")}] -> eventName and description equal, count ${cNew}, same event ${f.fliteId}, env=sandbox; initial Flite description ${JSON.stringify(desc0)}; EMPTY description: ${emptyNote}`, runIds, { eventId: f.fliteId, initial: f.remote, afterRename: ra, afterEmpty: rc });
    },
  };
};

const usd = (cost: string | undefined): number => Number(String(cost ?? "").split(",")[1]) / 100;
const flitePrices = (r: any): number[] => (r?.tickets ?? []).map((t: any) => Number(t.ticketPrice));

/** R8 base price change, then channel price formula, then an explicit channel price: Flite price = the channel's price. */
const R8: RowFn = async (m) => {
  const sc = await m.createScenario("r8", [{ name: "GA", cost: 1000, capacity: 50 }]);
  const tid = sc.tickets[0].id;
  return {
    expected: `${sc.name}: first publish => Flite GA price 10; owner base price -> 12.00 => Flite 12; a 10% markup price formula assigned to the ticket on the channel => Flite 13.2 (= the channel's price read back with x-cohost-channel-id); then an explicit channel price 15.00 => Flite 15; every run succeeds env=sandbox, only update-ticket operations, same Flite ticket id, event count stays 1; ${SYNTH}`,
    step: async () => {
      const p: string[] = [];
      const f = await firstPublish(m, sc, p);
      if (!f.fliteId) return done(["no Flite event after first publish", ...p], "", [f.run.runId], null);
      const runIds = [f.run.runId]; const seen: string[] = []; const rbs: Record<string, unknown> = {};
      const check = async (label: string, want: number) => {
        const r = await m.cycle(sc.eventId); runIds.push(r.run.runId); okRun(r.run, r.out, p, label);
        const chan = usd((await m.channelTickets(sc.eventId)).find((t) => t.id === tid)?.cost);
        const rb = compact(await m.fliteEvent(f.fliteId)); rbs[label] = { channelPrice: chan, ...rb };
        const got = flitePrices(rb);
        if (got.length !== 1 || Math.abs(got[0] - want) > 0.001) p.push(`${label}: Flite price ${JSON.stringify(got)}, wanted ${want}`);
        if (Math.abs(chan - want) > 0.001) p.push(`${label}: channel price ${chan}, wanted ${want}`);
        if (rb.tickets.map((t: any) => t._id).join() !== f.ticketIds.join()) p.push(`${label}: ticket ids changed`);
        if (ops(r.out).some((o) => o.startsWith("create"))) p.push(`${label}: created ${ops(r.out).join(",")}`);
        seen.push(`${label}: channel ${chan} -> Flite ${got.join(",")} ops=[${ops(r.out).join("+") || "-"}]`);
      };
      await m.h.cohostReq("PATCH", `/events/${sc.eventId}/tickets/${tid}`, { ticket: { costs: { cost: "USD,1200" } }, context: {} });
      await check("base price 12", 12);
      const fm: any = await m.h.cohostReq("POST", "/company/price-formulas", { name: `${m.tag}-r8-markup10`, markupPercent: 10 });
      const fid = fm?.data?.id as string; if (!fid) throw new Error("price formula create returned no id");
      await m.customize(sc.eventId, (c) => ({ ...c, pricing: { ...(c.pricing ?? {}), prices: {}, formulas: { [tid]: fid } } }));
      await check("formula +10%", 13.2);
      await m.customize(sc.eventId, (c) => ({ ...c, pricing: { ...(c.pricing ?? {}), formulas: {}, prices: { [tid]: "USD,1500" } } }));
      await check("channel price 15", 15);
      const cnt = await m.fliteCount(sc.name); if (cnt !== 1) p.push(`remote count ${cnt}`);
      return done(p, `${seen.join("; ")}; formula ${fid}; remote count ${cnt}; env=sandbox`, runIds, { eventId: f.fliteId, formulaId: fid, remoteCount: cnt, ...rbs });
    },
  };
};

/** R9 channel sales pause: tickets "false", nothing else changes; resume reopens them. */
const R9: RowFn = async (m) => {
  const sc = await m.createScenario("r9", TWO);
  return {
    expected: `${sc.name}: first publish => both tickets "true"; the organizer pauses sales on the channel (customization salesEnabled false) => run succeeds env=sandbox, every Flite ticket availability "false", the event is not ended, ticket ids unchanged, no creates; resuming => tickets "true" again; remote count stays 1; ${SYNTH}`,
    step: async () => {
      const p: string[] = [];
      const f = await firstPublish(m, sc, p);
      if (!f.fliteId) return done(["no Flite event after first publish", ...p], "", [f.run.runId], null);
      const runIds = [f.run.runId]; const rbs: Record<string, unknown> = {}; const seen: string[] = [];
      for (const [label, on, want] of [["paused", false, "false"], ["resumed", true, "true"]] as const) {
        await m.customize(sc.eventId, (c) => ({ ...c, salesEnabled: on }));
        const r = await m.cycle(sc.eventId); runIds.push(r.run.runId); okRun(r.run, r.out, p, label);
        const rb = compact(await m.fliteEvent(f.fliteId)); rbs[label] = rb;
        if (rb.tickets.some((t: any) => t.availability !== want)) p.push(`${label}: availability ${JSON.stringify(flip(rb).avail)}, wanted ${want}`);
        if (rb.isEventEnd === true) p.push(`${label}: event ended`);
        if (rb.tickets.map((t: any) => t._id).sort().join() !== f.ticketIds.join()) p.push(`${label}: ticket ids changed`);
        if (ops(r.out).some((o) => o.startsWith("create"))) p.push(`${label}: created ${ops(r.out).join(",")}`);
        seen.push(`${label}: ops=[${ops(r.out).join("+") || "-"}] tickets ${JSON.stringify(flip(rb).avail)} ended=${rb.isEventEnd}`);
      }
      const cnt = await m.fliteCount(sc.name); if (cnt !== 1) p.push(`remote count ${cnt}`);
      return done(p, `${seen.join("; ")}; remote count ${cnt}; env=sandbox`, runIds, { eventId: f.fliteId, remoteCount: cnt, ...rbs });
    },
  };
};

// ---- R10-R13: ticket lifecycle, capacity, cross-company, unsupported tickets ----
/** Ticket-triggered cycle: one `ticket_changed` ping for a ticket of the event, then its single run. */
async function tcycle(m: Matrix, eventId: string, ticketId: string, action: "offering.created" | "offering.updated" | "offering.deleted") {
  const before = await m.runIds();
  await m.ping("ticket_changed", action, `/events/${eventId}/tickets/${ticketId}`);
  const run = (await m.waitRuns(before, 1))[0];
  return { run, out: m.syncOut(run) };
}
const patchTicket = (m: Matrix, eventId: string, ticketId: string, ticket: Record<string, unknown>) => m.h.cohostReq("PATCH", `/events/${eventId}/tickets/${ticketId}`, { ticket, context: {} });
const tmap = (rb: any): Record<string, any> => Object.fromEntries((rb?.tickets ?? []).map((t: any) => [t.ticketName, t]));
const avail = (rb: any) => (rb?.tickets ?? []).map((t: any) => `${t.ticketName}=${t.availability}`).join(",");

/** R10 ticket add / remove / hidden / sold-out: add maps a new Flite ticket; every other change closes ("false") and never deletes. */
const R10: RowFn = async (m) => {
  const sc = await m.createScenario("r10", TWO);
  return {
    expected: `${sc.name}: first publish => GA + VIP "true". (a) a new ticket Late is added in Cohost => run succeeds env=sandbox, exactly 1 create-ticket, a ticket registration (RMS mapping) for it, Flite has 3 tickets; (b) VIP status hidden => VIP "false"; (c) GA status sold-out => GA "false"; (d) Late is removed (DELETE ticket) => Late "false". After every step all 3 Flite tickets still exist with the same ids (never deleted), no create beyond (a), remote event count stays 1; ${SYNTH}`,
    step: async () => {
      const p: string[] = [];
      const f = await firstPublish(m, sc, p);
      if (!f.fliteId) return done(["no Flite event after first publish", ...p], "", [f.run.runId], null);
      const runIds = [f.run.runId]; const rbs: Record<string, unknown> = {}; const seen: string[] = [];
      let ids = f.ticketIds;
      const check = async (label: string, r: { run: any; out: any }, wantCreates: number, wantAvail: Record<string, string>, nTickets: number) => {
        runIds.push(r.run.runId); okRun(r.run, r.out, p, label);
        const creates = ops(r.out).filter((o) => o === "create-ticket").length;
        if (creates !== wantCreates) p.push(`${label}: ${creates} create-ticket ops, wanted ${wantCreates}`);
        if (creates !== wantCreates) {
          const mapped = Object.keys(r.run?.nodes?.snapshot?.output?.mappings?.tickets ?? {});
          const unmapped = ((r.run?.nodes?.desired?.output?.desired?.tickets ?? []) as any[]).filter((t) => !mapped.includes(t.ticketId)).map((t) => `${t.fields?.ticketName}(${t.availability})`);
          p.push(`${label}: diagnostic: desired tickets with no mapping in the snapshot: [${unmapped.join(",")}] (snapshot mappings cover ${mapped.length} ticket(s))`);
        }
        if (ops(r.out).some((o) => o.startsWith("create") && o !== "create-ticket")) p.push(`${label}: unexpected create ${ops(r.out).join(",")}`);
        const rb = compact(await m.fliteEvent(f.fliteId)); rbs[label] = rb;
        if (rb.tickets.length !== nTickets) p.push(`${label}: flite has ${rb.tickets.length} tickets, wanted ${nTickets} (a ticket was deleted or duplicated)`);
        const have = tmap(rb);
        for (const [name, want] of Object.entries(wantAvail)) if (have[name]?.availability !== want) p.push(`${label}: ${name} availability ${have[name]?.availability}, wanted ${want}`);
        const got: string[] = rb.tickets.map((t: any) => t._id);
        if (!ids.every((i) => got.includes(i))) p.push(`${label}: an earlier Flite ticket id vanished`);
        ids = got.slice().sort();
        seen.push(`${label}: ops=[${ops(r.out).join("+") || "-"}] ${avail(rb)}`);
        return rb;
      };
      // (a) add
      const late = (await m.h.cohostReq("POST", `/events/${sc.eventId}/tickets`, { ticket: { name: "Late", type: "admission", category: "general", priceCategory: "paid", capacity: 30, maximumQuantity: 10, costs: { cost: "USD,1500" }, status: "live" } }));
      const lateId = Object.keys(late?.data?.ids ?? {})[0];
      if (!lateId) return done(["ticket Late create returned no id", ...p], "", runIds, null);
      const a = await tcycle(m, sc.eventId, lateId, "offering.created");
      const rbA = await check("add", a, 1, { GA: "true", VIP: "true", Late: "true" }, 3);
      if (!((a.out?.registrations ?? []) as any[]).some((r) => r.labels?.kind === "ticket" && JSON.stringify(r).includes(lateId))) p.push("add: no ticket registration for the new ticket");
      if (Number(tmap(rbA).Late?.ticketPrice) !== 15) p.push(`add: Late price ${tmap(rbA).Late?.ticketPrice}`);
      // (b) hidden
      const vip = sc.tickets.find((t) => t.name === "VIP")!; const ga = sc.tickets.find((t) => t.name === "GA")!;
      await patchTicket(m, sc.eventId, vip.id, { status: "hidden" });
      await check("hidden", await tcycle(m, sc.eventId, vip.id, "offering.updated"), 0, { GA: "true", VIP: "false", Late: "true" }, 3);
      // (c) sold-out
      await patchTicket(m, sc.eventId, ga.id, { status: "sold-out" });
      await check("sold-out", await tcycle(m, sc.eventId, ga.id, "offering.updated"), 0, { GA: "false", VIP: "false", Late: "true" }, 3);
      // (d) remove
      await m.h.cohostReq("DELETE", `/events/${sc.eventId}/tickets/${lateId}`);
      await check("removed", await tcycle(m, sc.eventId, lateId, "offering.deleted"), 0, { GA: "false", VIP: "false", Late: "false" }, 3);
      const cnt = await m.fliteCount(sc.name); if (cnt !== 1) p.push(`remote count ${cnt}`);
      return done(p, `${seen.join("; ")}; remote count ${cnt}; env=sandbox`, runIds, { eventId: f.fliteId, remoteCount: cnt, lateCohostTicketId: lateId, ...rbs });
    },
  };
};

/** R11 capacity: Flite capacity = Cohost capacity - sold. A sale cannot be created through the slot-2 API, so the partial-sale half is RECORDED, not proven. */
const R11: RowFn = async (m) => {
  const sc = await m.createScenario("r11", TWO);
  return {
    expected: `${sc.name}: first publish => Flite capacity GA 50, VIP 20 (sold 0). Reducing GA capacity to 40 => Flite GA capacity 40 (= 40 - sold 0), then to 5 => 5, availability stays "true", ticket ids unchanged, only update-ticket ops. Partial sale: no slot-2 API route can create a sale (POST /orders 403, POST /events/:id/orders 404, PATCH ticket quantitySold ignored, POST attendees needs an existing attendee), so the "capacity - sold" arithmetic with sold > 0 is NOT driven live; status is RECORDED, not PASS; ${SYNTH}`,
    step: async () => {
      const p: string[] = [];
      const f = await firstPublish(m, sc, p);
      if (!f.fliteId) return done(["no Flite event after first publish", ...p], "", [f.run.runId], null);
      const runIds = [f.run.runId]; const rbs: Record<string, unknown> = {}; const seen: string[] = [];
      const ga = sc.tickets.find((t) => t.name === "GA")!;
      const first = tmap(f.remote);
      if (first.GA?.capacity !== 50 || first.VIP?.capacity !== 20) p.push(`first publish capacities GA ${first.GA?.capacity} VIP ${first.VIP?.capacity}`);
      for (const cap of [40, 5]) {
        await patchTicket(m, sc.eventId, ga.id, { capacity: cap });
        const r = await tcycle(m, sc.eventId, ga.id, "offering.updated"); const label = `cap${cap}`;
        runIds.push(r.run.runId); okRun(r.run, r.out, p, label);
        const rb = compact(await m.fliteEvent(f.fliteId)); rbs[label] = rb; const have = tmap(rb);
        if (have.GA?.capacity !== cap - (have.GA?.sold ?? 0)) p.push(`${label}: Flite GA capacity ${have.GA?.capacity} sold ${have.GA?.sold}, wanted ${cap} - sold`);
        if (have.GA?.availability !== "true") p.push(`${label}: GA availability ${have.GA?.availability}`);
        if (have.VIP?.capacity !== 20) p.push(`${label}: VIP capacity ${have.VIP?.capacity}`);
        if (rb.tickets.map((t: any) => t._id).sort().join() !== f.ticketIds.join()) p.push(`${label}: ticket ids changed`);
        if (ops(r.out).some((o) => o !== "update-ticket")) p.push(`${label}: ops ${ops(r.out).join(",")}`);
        seen.push(`${label}: Flite GA capacity ${have.GA?.capacity} sold ${have.GA?.sold} ops=[${ops(r.out).join("+") || "-"}]`);
      }
      return done(p, `${seen.join("; ")}; partial-sale half not drivable (no slot-2 sale route) => capacity - sold with sold>0 only covered by T1 unit tests; env=sandbox`, runIds, { eventId: f.fliteId, ...rbs }, { recorded: p.length === 0 });
    },
  };
};

/** Flite staging event count over every page of get-events-all (null if more than 30 pages) + the number of events carrying this run's tag. */
async function fliteCounts(m: Matrix): Promise<{ total: number | null; tagged: number }> {
  const auth = await (m as any).fliteAuth();
  let total: number | null = 0;
  for (let page = 1; ; page++) {
    if (page > 30) { total = null; break; }
    const r = await m.h.fliteGet(`${FLITE_STAGING}/get-events-all?page=${page}&limit=100`, auth);
    const n = ((r?.data ?? []) as any[]).length; total += n;
    if (n < 100) break;
  }
  const tg = await m.h.fliteGet(`${FLITE_STAGING}/get-events-all?page=1&limit=100&search=${encodeURIComponent(m.tag)}`, auth);
  return { total, tagged: ((tg?.data ?? []) as any[]).length };
}
const nodeStates = (run: any) => Object.fromEntries(Object.entries(run?.nodes ?? {}).map(([k, v]: [string, any]) => [k, v?.status ?? "?"]));

/** R12 cross-company: an event the connection's company cannot read => run failed, no Flite write. */
const R12: RowFn = async (m) => {
  const foreign = `fscforeign${rid()}${rid()}`;
  return {
    expected: `a channel ping for event ${foreign}, which the connection's company (acme-corp) cannot read (the slot-2 seed has only acme-corp events, a second auth user gets 403 on every route and Firestore cannot be seeded, so a foreign-company event is represented by an id the API does not serve to this company: the snapshot's owner read answers 403/404, the documented cross-company negative) => the run ends failed at the snapshot node; the desired/sync/register nodes never run (no sync output); Flite staging event count (total, and carrying this run's tag) is the same before and after; ${SYNTH}`,
    step: async () => {
      const p: string[] = [];
      const own = await m.h.cohostReq("GET", `/events/${foreign}`).then(() => "readable", (e) => (e as Error).message);
      if (own === "readable") p.push("the foreign id is readable by the connection's company; row is not a cross-company probe");
      const before = await fliteCounts(m);
      const r = await m.cycle(foreign, "channelEvent.listed");
      const after = await fliteCounts(m);
      const states = nodeStates(r.run);
      if (r.run.status !== "failed") p.push(`run status ${r.run.status}, wanted failed`);
      if (states.snapshot !== "failed") p.push(`snapshot node ${states.snapshot}, wanted failed`);
      for (const n of ["desired", "sync", "register"]) if (states[n] && !["skipped", "pending", "not_run", "cancelled", "canceled"].includes(String(states[n]))) p.push(`${n} node ${states[n]}, wanted not run`);
      if (r.out) p.push(`sync produced output ${JSON.stringify(r.out).slice(0, 80)}`);
      if (JSON.stringify(before) !== JSON.stringify(after)) p.push(`Flite counts changed ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      return done(p, `run ${r.run.runId} status=${r.run.status}, nodes ${JSON.stringify(states)}, no sync output, owner read of the id: ${own}; Flite staging counts before ${JSON.stringify(before)} after ${JSON.stringify(after)} (the workflow's own Flite calls run inside w6w and are not in flite-requests.log; the run graph plus the unchanged counts are the zero-write evidence)`, [r.run.runId], { foreignEventId: foreign, ownerRead: own, before, after, nodes: states });
    },
  };
};

/** R13 non-USD and donation tickets: the run errors for them, no Flite ticket is created for them; the valid ticket still publishes. */
const R13: RowFn = async (m) => {
  const sc = await m.createScenario("r13", [{ name: "GA", cost: 1000, capacity: 50 }]);
  const mk = async (name: string, priceCategory: string, cost: string) => {
    const r = await m.h.cohostReq("POST", `/events/${sc.eventId}/tickets`, { ticket: { name, type: "admission", category: "general", priceCategory, capacity: 10, maximumQuantity: 10, costs: { cost }, status: "live" } });
    const id = Object.keys(r?.data?.ids ?? {})[0]; if (!id) throw new Error(`${name} create returned no id`); return id;
  };
  const eurId = await mk("EUR", "paid", "EUR,1000");
  const donId = await mk("Donation", "donation", "USD,0");
  const listed = await m.channelTickets(sc.eventId);
  return {
    expected: `${sc.name}: tickets GA (USD 10.00), EUR (EUR 10.00) and Donation (priceCategory donation) on one event => the run ends failed (the report node throws on sync errors) with errors naming the EUR ticket (currency EUR is not USD) and the donation ticket; Flite has the event with exactly 1 ticket (GA, 10.00); no Flite ticket named EUR or Donation and no ticket registration for them; a second ping creates none either; ${SYNTH}`,
    step: async () => {
      const p: string[] = [];
      const r1 = await m.cycle(sc.eventId, "channelEvent.listed");
      const out = r1.out; const runIds = [r1.run.runId];
      if (r1.run.status !== "failed") p.push(`run status ${r1.run.status}, wanted failed`);
      if (out?.env !== "sandbox") p.push(`env=${out?.env}`);
      const errs: string[] = (out?.errors ?? []).map(String);
      if (!errs.some((e) => e.includes(eurId) && /EUR/.test(e))) p.push(`no error for the EUR ticket: ${JSON.stringify(errs).slice(0, 200)}`);
      if (!errs.some((e) => e.includes(donId) && /donation/i.test(e))) p.push(`no error for the donation ticket: ${JSON.stringify(errs).slice(0, 200)}`);
      const regs = ((out?.registrations ?? []) as any[]).filter((r) => r.labels?.kind === "ticket");
      if (regs.length !== 1) p.push(`${regs.length} ticket registrations, wanted 1 (GA only)`);
      if (regs.some((r) => JSON.stringify(r).includes(eurId) || JSON.stringify(r).includes(donId))) p.push("a registration references the EUR/donation ticket");
      const fliteId: string = out?.eventId ?? ""; let rb: any = null;
      if (!fliteId) p.push("sync output has no eventId"); else {
        rb = compact(await m.fliteEvent(fliteId));
        if (rb.tickets.length !== 1 || rb.tickets[0].ticketName !== "GA" || Number(rb.tickets[0].ticketPrice) !== 10) p.push(`Flite tickets ${JSON.stringify(rb.tickets.map((t: any) => `${t.ticketName}@${t.ticketPrice}`))}, wanted only GA@10`);
      }
      const r2 = await m.cycle(sc.eventId, "channelEvent.changed"); runIds.push(r2.run.runId);
      if (ops(r2.out).some((o) => o.startsWith("create"))) p.push(`second ping created ${ops(r2.out).join(",")}`);
      const rb2 = fliteId ? compact(await m.fliteEvent(fliteId)) : null;
      if (rb2 && rb2.tickets.length !== 1) p.push(`after second ping Flite has ${rb2.tickets.length} tickets`);
      const cnt = await m.fliteCount(sc.name); if (cnt !== 1) p.push(`remote count ${cnt}`);
      return done(p, `run ${r1.run.runId} ${r1.run.status}: ${errs.length} error(s) [${errs.map((e) => e.slice(0, 70)).join(" | ")}]; Flite event ${fliteId} has tickets ${(rb?.tickets ?? []).map((t: any) => `${t.ticketName}@${t.ticketPrice}`).join(",")}; 2nd ping ops=[${ops(r2.out).join("+") || "-"}]; remote count ${cnt}; channel view tickets ${listed.map((t) => `${t.name}:${t.cost}`).join(",")}`, runIds, { eventId: fliteId, remoteCount: cnt, eurTicket: eurId, donationTicket: donId, errors: errs, ...rb2 });
    },
  };
};

const ROW_FNS: Record<string, RowFn> = { R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13 };

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
