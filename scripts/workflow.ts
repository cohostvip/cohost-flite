// Offline validation + install/publish/status for workflows/flite-sales-channel.workflow.json.
// No process.env; tokens only via --token-file; mutating calls need --apply.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Json = Record<string, any>;

/** Pinned T2 (vip.cohost.w6w) action + trigger keys this workflow may use. */
export const A_KEYS = ["get-channel-event-snapshot", "register-urn-mappings"] as const;
export const A_TRIGGERS = ["channel-event-changed", "ticket-changed"] as const;
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
  const triggers = nodes.filter((n) => n.uses?.trigger === true);
  const tkeys = triggers.map((n) => n.uses.action).sort();
  if (triggers.length !== 2 || tkeys.join() !== [...A_TRIGGERS].sort().join()) {
    errs.push(`need exactly two trigger nodes (${A_TRIGGERS.join(", ")}); found ${tkeys.join(", ") || "none"}`);
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
  const report = nodes.find((n) => n.uses?.app === "@w6w/script");
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
    if (!j(w(sync).expectedEnv).includes("vars.env")) errs.push("sync.expectedEnv must come from vars.env");
    if (!j(w(sync).desired).includes(`steps.${desired.id}.output`)) errs.push("sync.desired must come from the transformer step");
    if (!j(w(reg).mappings).includes(`steps.${sync.id}.output.registrations`)) errs.push("register.mappings must be sync registrations");
    if (!(reg.retry?.maxAttempts >= 3)) errs.push("register step needs retry.maxAttempts >= 3");
    if (!j(w(report).input).includes(`steps.${sync.id}.output.errors`)) errs.push("terminal step must read sync errors");
    if (!/throw/.test(String(w(report).code ?? ""))) errs.push("terminal step code must throw on errors");
  }
  const text = JSON.stringify(wf);
  if (/"(token|apiKey|password|secret|accessToken)"\s*:/i.test(text)) errs.push("credential-looking key in workflow");
  for (const [ref, c] of Object.entries<Json>(wf.connections ?? {})) {
    if (c.connection !== null) errs.push(`connection ${ref} must be null (bound at install)`);
  }
  for (const n of nodes) if (n.uses?.connection) errs.push(`node ${n.id} embeds a connection id`);
  return errs;
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
    else if (a === "--token") throw new Error("--token is rejected; use --token-file <path>");
    else if (a === "--var" || a === "--connection") {
      const [k, ...rest] = (argv[++i] ?? "").split("=");
      (a === "--var" ? vars : conns)[k] = rest.join("=");
    } else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else pos.push(a);
  }
  return { flags, vars, conns, pos, apply };
}

async function remote(cmd: string, file: string | undefined, o: ReturnType<typeof parseArgs>): Promise<number> {
  const { w6w, project, "token-file": tokenFile } = o.flags;
  if (!w6w || !project || !tokenFile) throw new Error(`${cmd} needs --w6w <url> --project <p> --token-file <path>`);
  const base = `${w6w.replace(/\/+$/, "")}/projects/${encodeURIComponent(project)}/workflows`;
  let method = "GET";
  let path = base;
  let body: string | undefined;
  if (cmd !== "status") {
    if (!file) throw new Error(`${cmd} needs a workflow file`);
    const wf = JSON.parse(readFileSync(file, "utf8")) as Json;
    const errs = await validateWorkflow(wf);
    if (errs.length) { for (const e of errs) console.error(`invalid: ${e}`); return 1; }
    for (const [k, v] of Object.entries(o.vars)) {
      const d = (wf.variables as Json[]).find((x) => x.key === k);
      if (!d) throw new Error(`unknown --var ${k}`);
      d.default = v;
    }
    for (const [ref, id] of Object.entries(o.conns)) {
      if (!wf.connections?.[ref]) throw new Error(`unknown --connection ref ${ref}`);
      wf.connections[ref].connection = id;
    }
    method = "POST";
    path = cmd === "publish" ? `${base}/${wf.key}/publish` : base;
    body = JSON.stringify(wf);
  } else path = `${base}/flite-sales-channel`;
  console.log(`${method} ${path}`);
  if (!o.apply && method !== "GET") { console.log("dry run (pass --apply to send)"); return 0; }
  const token = readFileSync(tokenFile, "utf8").trim();
  const res = await fetch(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body });
  console.log(`status ${res.status}`);
  return res.ok ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  let o;
  try { o = parseArgs(rest); } catch (e) { console.error((e as Error).message); return 1; }
  try {
    if (cmd === "validate") {
      const file = o.pos[0];
      if (!file || !existsSync(file)) { console.error("validate <file>: file not found"); return 1; }
      const errs = await validateWorkflow(JSON.parse(readFileSync(file, "utf8")));
      for (const e of errs) console.error(`invalid: ${e}`);
      if (!errs.length) console.log("ok");
      return errs.length ? 1 : 0;
    }
    if (cmd === "install" || cmd === "publish" || cmd === "status") return await remote(cmd, o.pos[0], o);
    console.error("usage: workflow.ts validate <file> | install|publish <file> | status --w6w <url> --project <p> --token-file <path> [--var k=v] [--connection ref=id] [--apply]");
    return 1;
  } catch (e) { console.error((e as Error).message); return 1; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
void ROOT;
