// Offline validation + install/publish/status for workflows/flite-sales-channel.workflow.json.
// No process.env; tokens only via --token-file; mutating calls need --apply.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Json = Record<string, any>;

/** Pinned T2 (vip.cohost.w6w) action + trigger keys this workflow may use. */
export const A_KEYS = ["get-channel-event-snapshot", "register-urn-mappings", "resolve-urn", "upsert-order"] as const;
export const A_TRIGGERS = ["channel-event-changed", "channel-ticket-changed"] as const;
const APP_A = "vip.cohost.w6w";
const APP_F = "vip.cohost.flite";
const APP_X = "vip.cohost.transformers.flite";
const RACE = "@w6w/race";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function appKeys(rel: string): Promise<string[]> {
  const mod = await import(new URL(`../${rel}`, import.meta.url).href);
  return (mod.default.actions as Array<{ key: string }>).map((a) => a.key);
}

export async function validateWorkflow(wf: Json, indexes?: { flite: string[]; transformer: string[] }): Promise<string[]> {
  const errs: string[] = [];
  const fl = indexes ?? { flite: await appKeys("packages/flite/index.ts"), transformer: await appKeys("packages/cohost-flite-transformer/index.ts") };
  if (wf.manifestVersion !== "2") errs.push('manifestVersion must be "2"');
  const nodes: Json[] = Array.isArray(wf.nodes) ? wf.nodes : [];
  const edges: Json[] = Array.isArray(wf.edges) ? wf.edges : [];
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) errs.push("duplicate node ids");
  for (const e of edges) {
    if (!ids.has(e.from)) errs.push(`edge from unknown node ${e.from}`);
    if (!ids.has(e.to)) errs.push(`edge to unknown node ${e.to}`);
  }
  const isOrderTrigger = (n: Json) => n.uses?.trigger === true && n.uses?.app === APP_F && n.uses?.action === "order-placed";
  const orderTriggers = nodes.filter(isOrderTrigger);
  const triggers = nodes.filter((n) => n.uses?.trigger === true && !isOrderTrigger(n));
  const tkeys = triggers.map((n) => n.uses.action).sort();
  if (triggers.length !== 2 || tkeys.join() !== [...A_TRIGGERS].sort().join()) {
    errs.push(`need exactly two trigger nodes (${A_TRIGGERS.join(", ")}); found ${tkeys.join(", ") || "none"}`);
  }
  if (orderTriggers.length !== 1) errs.push(`need exactly one ${APP_F} order-placed trigger node (the third root); found ${orderTriggers.length}`);
  for (const t of triggers) {
    if (t.with?.channelId === undefined) errs.push(`trigger ${t.id} must carry a channelId param`);
  }
  const races = nodes.filter((n) => n.uses?.app === RACE);
  if (races.length !== 1) errs.push("need exactly one @w6w/race node");
  const race = races[0];
  for (const t of triggers) {
    const out = edges.filter((e) => e.from === t.id);
    if (out.length !== 1 || (race && out[0].to !== race.id)) errs.push(`trigger ${t.id} needs exactly one edge into the race node`);
  }
  const byAction = (app: string, action: string) => nodes.find((n) => n.uses?.app === app && n.uses?.action === action && n.uses?.trigger !== true);
  for (const n of nodes) {
    const u = n.uses ?? {};
    if (isOrderTrigger(n)) continue;
    if (u.trigger === true) {
      if (u.app !== APP_A || !(A_TRIGGERS as readonly string[]).includes(u.action)) errs.push(`node ${n.id}: unknown trigger ${u.app}/${u.action}`);
    } else if (u.app === APP_A) {
      if (!(A_KEYS as readonly string[]).includes(u.action)) errs.push(`node ${n.id}: unknown ${APP_A} action ${u.action}`);
    } else if (u.app === APP_F) {
      if (!fl.flite.includes(u.action)) errs.push(`node ${n.id}: action ${u.action} not in flite index`);
    } else if (u.app === APP_X) {
      if (!fl.transformer.includes(u.action)) errs.push(`node ${n.id}: action ${u.action} not in transformer index`);
    }
  }
  const snap = byAction(APP_A, "get-channel-event-snapshot");
  const desired = byAction(APP_X, "channel-event-to-flite");
  const sync = byAction(APP_F, "sync-event");
  const reg = byAction(APP_A, "register-urn-mappings");
  for (const [name, n] of [["get-channel-event-snapshot", snap], ["channel-event-to-flite", desired], ["sync-event", sync], ["register-urn-mappings", reg]] as const) {
    if (!n) errs.push(`missing step ${name}`);
  }
  // terminal: a script step that throws when sync errors non-empty
  const report = nodes.find((n) => n.id === "report" && n.uses?.app === "@w6w/script");
  if (!report) errs.push("missing terminal failing step (@w6w/script)");
  if (race && snap && desired && sync && reg && report) {
    const chain = [race, snap, desired, sync, reg, report];
    for (let i = 0; i < chain.length - 1; i++) {
      if (!edges.some((e) => e.from === chain[i].id && e.to === chain[i + 1].id)) errs.push(`missing edge ${chain[i].id} -> ${chain[i + 1].id}`);
    }
    if (edges.some((e) => e.from === sync.id && e.to === report.id)) errs.push("terminal step must not be reachable directly from sync (must follow register)");
    if (edges.some((e) => e.from === report.id)) errs.push("terminal step must have no outgoing edge");
    const j = (x: unknown) => JSON.stringify(x ?? null);
    const w = (n: Json) => n.with ?? {};
    for (const k of ["eventId", "companyId"]) {
      if (!j(w(snap)[k]).includes(`steps.${race.id}.output.meta.${k}`)) errs.push(`snapshot.${k} must come from steps.${race.id}.output.meta.${k}`);
    }
    if (!j(w(snap).listingId).includes(`steps.${race.id}.output.meta.listingId`)) errs.push("snapshot.listingId must come from race meta");
    const ml = w(snap).mappingLabels ?? {};
    if (Object.keys(ml).sort().join() !== "channelId,env,org,provider" || ml.provider !== "flite") errs.push("mappingLabels must be exactly {provider:flite, env, org, channelId} (no listingId)");
    const bound = (v: any, ref: string) => v && typeof v === "object" && v.$ === ref;
    if (!bound(ml.env, "vars.env")) errs.push("mappingLabels.env must be bound to vars.env");
    if (!bound(w(sync).expectedEnv, "vars.env")) errs.push("sync.expectedEnv must be bound to vars.env");
    if (!bound(w(desired).snapshot, `steps.${snap.id}.output`)) errs.push(`channel-event-to-flite.snapshot must be bound to steps.${snap.id}.output`);
    if (!j(w(sync).desired).includes(`steps.${desired.id}.output`)) errs.push("sync.desired must come from the transformer step");
    if (!j(w(reg).mappings).includes(`steps.${sync.id}.output.registrations`)) errs.push("register.mappings must be sync registrations");
    if (!(reg.retry?.maxAttempts >= 3)) errs.push("register step needs retry.maxAttempts >= 3");
    if (!j(w(report).input).includes(`steps.${sync.id}.output.errors`)) errs.push("terminal step must read sync errors");
    const code = String(w(report).code ?? "");
    if (!/if\s*\(.*(length|\.some|!==\s*0|>\s*0).*\)\s*\{?\s*throw\b/.test(code)) errs.push("terminal step code must throw when errors is non-empty");
    // report must be reachable only through register: no path sync -> ... -> report avoiding register
    const seen = new Set<string>([sync.id]);
    const stack = [sync.id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of edges.filter((x) => x.from === cur)) {
        if (e.to === reg.id || seen.has(e.to)) continue;
        seen.add(e.to);
        stack.push(e.to);
      }
    }
    if (seen.has(report.id)) errs.push("terminal step reachable without passing register");
  }
  validateOrderRoot(wf, nodes, edges, orderTriggers[0], byAction, errs);
  if (typeof wf.id !== "string" || !WF_ID.test(wf.id)) errs.push(`id must match ${WF_ID} (server grammar)`);
  if (typeof wf.key !== "string" || !WF_KEY.test(wf.key)) errs.push("key must be an account slug [a-z0-9-]");
  const text = JSON.stringify(wf);
  if (/"(token|apiKey|password|secret|accessToken)"\s*:/i.test(text)) errs.push("credential-looking key in workflow");
  for (const [ref, c] of Object.entries<Json>(wf.connections ?? {})) {
    if (c.connection !== null) errs.push(`connection ${ref} must be null (bound at install)`);
  }
  for (const n of nodes) if (n.uses?.connection) errs.push(`node ${n.id} embeds a connection id`);
  return errs;
}

/** Third root: Flite order-placed -> transform-order -> mapped-event lookup -> guard -> upsert-order. */
function validateOrderRoot(wf: Json, nodes: Json[], edges: Json[], trig: Json | undefined, byAction: (app: string, action: string) => Json | undefined, errs: string[]): void {
  const xform = byAction(APP_X, "transform-order");
  const mapping = byAction(APP_A, "resolve-urn");
  const upsert = byAction(APP_A, "upsert-order");
  const guard = nodes.find((n) => n.id === "order_guard" && n.uses?.app === "@w6w/script");
  for (const [name, n] of [["order trigger", trig], ["transform-order", xform], ["resolve-urn", mapping], ["order_guard script", guard], ["upsert-order", upsert]] as const) {
    if (!n) errs.push(`missing order-root step ${name}`);
  }
  if (!trig || !xform || !mapping || !guard || !upsert) return;
  const chain = [trig, xform, mapping, guard, upsert];
  for (let i = 0; i < chain.length - 1; i++) {
    if (!edges.some((e) => e.from === chain[i].id && e.to === chain[i + 1].id)) errs.push(`missing edge ${chain[i].id} -> ${chain[i + 1].id}`);
  }
  // upsert-order is reachable only through the guard: every inbound edge is guard -> upsert, and no path from any other node avoids the guard
  for (const e of edges.filter((x) => x.to === upsert.id)) {
    if (e.from !== guard.id) errs.push(`upsert-order must only be reachable through the guard (edge ${e.from} -> ${e.to})`);
  }
  const seen = new Set<string>([trig.id]);
  const stack = [trig.id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of edges.filter((x) => x.from === cur)) {
      if (e.to === guard.id || seen.has(e.to)) continue;
      seen.add(e.to);
      stack.push(e.to);
    }
  }
  if (seen.has(upsert.id)) errs.push("upsert-order reachable without passing the order guard");
  const w = (n: Json) => n.with ?? {};
  const bound = (v: any, ref: string) => v && typeof v === "object" && v.$ === ref;
  if (!bound(w(xform).order, `steps.${trig.id}.output.order`)) errs.push(`transform-order.order must be bound to steps.${trig.id}.output.order`);
  if (!bound(w(xform).companyId, "vars.companyId")) errs.push("transform-order.companyId must be bound to vars.companyId");
  if (!bound(w(xform).env, "vars.env")) errs.push("transform-order.env must be bound to vars.env");
  if (!(wf.variables as Json[] | undefined)?.some((v) => v.key === "companyId" && v.required === true)) errs.push("variable companyId (required) is missing");
  if (!bound(w(mapping).urn, `steps.${xform.id}.output.order.contextId`)) errs.push(`resolve-urn.urn must be bound to steps.${xform.id}.output.order.contextId`);
  // resolve-urn returns the URN's own mapping doc; it must not be narrowed by a labels/type filter (the guard verifies ownership instead)
  for (const k of Object.keys(w(mapping))) if (k !== "urn") errs.push(`resolve-urn must take only urn (found ${k}); ownership is verified by the guard`);
  const gi = w(guard).input ?? {};
  if (!bound(gi.mapping, `steps.${mapping.id}.output`)) errs.push(`order guard input.mapping must be bound to steps.${mapping.id}.output`);
  const ex = gi.expected ?? {};
  if (Object.keys(ex).sort().join() !== "channelId,env,org,provider" || ex.provider !== "flite") errs.push("order guard input.expected must be exactly {provider:flite, env, org, channelId}");
  for (const k of ["env", "org", "channelId"]) if (!bound(ex[k], `vars.${k}`)) errs.push(`order guard input.expected.${k} must be bound to vars.${k}`);
  const gcode = String(w(guard).code ?? "");
  if (!/throw\b/.test(gcode) || !/Array\.isArray/.test(gcode) || !/resources/.test(gcode) || !/labels/.test(gcode)) errs.push("order guard code must throw unless mapping.resources is a non-empty array and mapping.labels match expected");
  if (!bound(w(upsert).data?.order, `steps.${xform.id}.output.order`)) errs.push(`upsert-order.data.order must be bound to steps.${xform.id}.output.order`);
  if (!(upsert.retry?.maxAttempts >= 3)) errs.push("upsert-order step needs retry.maxAttempts >= 3");
  if (edges.some((e) => e.from === upsert.id)) errs.push("upsert-order must have no outgoing edge");
  // connection refs bound on every order-root node that talks to an app account
  const want: Array<[Json, string]> = [[trig, "flite"], [mapping, "cohost"], [upsert, "cohost"]];
  for (const [n, ref] of want) {
    if (n.uses.connectionRef !== ref) errs.push(`node ${n.id} must use connectionRef ${ref}`);
    else if (!wf.connections?.[ref]) errs.push(`node ${n.id}: connectionRef ${ref} is not declared in connections`);
  }
}

/** Writes the channel id literal into every channel trigger node's `with.channelId` (the engine stores trigger params unresolved). The Flite order trigger has no channelId param and is skipped. */
export function bindChannelTriggers(wf: Json, channelId: string): void {
  const triggers = (wf.nodes as Json[]).filter((n) => n.uses?.trigger === true && n.uses?.app !== APP_F);
  for (const t of triggers) {
    if (!t.with || t.with.channelId === undefined) throw new Error(`trigger ${t.id} has no channelId param to bind`);
    t.with.channelId = channelId;
  }
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  const vars: Record<string, string> = {};
  const conns: Record<string, string> = {};
  const pos: string[] = [];
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--token" || a.startsWith("--token=")) throw new Error("--token is rejected; use --token-file <path>");
    else if (a === "--var" || a === "--connection") {
      const [k, ...rest] = (argv[++i] ?? "").split("=");
      (a === "--var" ? vars : conns)[k] = rest.join("=");
    } else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else pos.push(a);
  }
  return { flags, vars, conns, pos, apply };
}

export interface Io { fetch: typeof fetch; out: (s: string) => void; err: (s: string) => void }
const realIo: Io = { fetch: (...a) => fetch(...a), out: (s) => console.log(s), err: (s) => console.error(s) };

/** Server id grammar (`POST /workflows`, w6w endpoints.json workflows.create): `^wf_[A-Za-z0-9-]{1,64}$`. */
const WF_ID = /^wf_[A-Za-z0-9-]{1,64}$/;
/** Account-slug key grammar (`[a-z0-9-]`, no underscore — w6w admin id-or-key.ts). */
const WF_KEY = /^[a-z0-9-]+$/;
const DEFAULT_ID = "wf_flite-sales-channel";

/**
 * Real w6w surface (admin/callable-routes.ts + admin/triggers.ts): `POST /workflows` upserts a
 * definition (optional `?project=`), `POST /workflows/:id/publish` publishes and reconciles one
 * subscription per trigger node, and `GET /workflows/:id[/subscriptions|/runs]` reads it back.
 * Paths are root-relative to --w6w; there is no `/projects/<p>/` prefix.
 */
async function remote(cmd: string, file: string | undefined, o: ReturnType<typeof parseArgs>, io: Io): Promise<number> {
  const { w6w, project, "token-file": tokenFile } = o.flags;
  if (!w6w || !tokenFile) throw new Error(`${cmd} needs --w6w <url> --token-file <path> [--project <p>]`);
  const base = `${w6w.replace(/\/+$/, "")}/workflows`;
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  if (cmd === "status") {
    const id = o.flags.id ?? DEFAULT_ID;
    for (const suffix of ["", "/subscriptions", "/runs"]) calls.push({ method: "GET", path: `${base}/${encodeURIComponent(id)}${suffix}` });
  } else {
    if (!file) throw new Error(`${cmd} needs a workflow file`);
    const wf = JSON.parse(readFileSync(file, "utf8")) as Json;
    const errs = await validateWorkflow(wf);
    if (errs.length) { for (const e of errs) io.err(`invalid: ${e}`); return 1; }
    for (const [k, v] of Object.entries(o.vars)) {
      const d = (wf.variables as Json[]).find((x) => x.key === k);
      if (!d) throw new Error(`unknown --var ${k}`);
      d.default = v;
    }
    if (o.vars.channelId) bindChannelTriggers(wf, o.vars.channelId);
    for (const [ref, id] of Object.entries(o.conns)) {
      if (!wf.connections?.[ref]) throw new Error(`unknown --connection ref ${ref}`);
      wf.connections[ref].connection = id;
    }
    if (cmd === "publish") calls.push({ method: "POST", path: `${base}/${encodeURIComponent(wf.id)}/publish` });
    else calls.push({ method: "POST", path: project ? `${base}?project=${encodeURIComponent(project)}` : base, body: JSON.stringify(wf) });
  }
  const mutating = calls.some((c) => c.method !== "GET");
  for (const c of calls) io.out(`${c.method} ${c.path}`);
  if (!o.apply && mutating) { io.err("dry run (pass --apply to send)"); return 0; }
  const token = readFileSync(tokenFile, "utf8").trim();
  let ok = true;
  for (const c of calls) {
    const res = await io.fetch(c.path, { method: c.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: c.body });
    io.err(`status ${res.status}`);
    ok = ok && res.ok;
  }
  return ok ? 0 : 1;
}

export async function main(argv: string[], io: Io = realIo): Promise<number> {
  const [cmd, ...rest] = argv;
  let o;
  try { o = parseArgs(rest); } catch (e) { io.err((e as Error).message); return 1; }
  try {
    if (cmd === "validate") {
      const file = o.pos[0];
      if (!file || !existsSync(file)) { io.err("validate <file>: file not found"); return 1; }
      const errs = await validateWorkflow(JSON.parse(readFileSync(file, "utf8")));
      for (const e of errs) io.err(`invalid: ${e}`);
      if (!errs.length) io.out("ok");
      return errs.length ? 1 : 0;
    }
    if (cmd === "install" || cmd === "publish" || cmd === "status") return await remote(cmd, o.pos[0], o, io);
    io.err("usage: workflow.ts validate <file> | install|publish <file> | status --w6w <url> --token-file <path> [--project <p>] [--id <wf_id>] [--var k=v] [--connection ref=id] [--apply]");
    return 1;
  } catch (e) { io.err((e as Error).message); return 1; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
void ROOT;
