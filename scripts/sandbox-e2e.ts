// Sandbox E2E harness shell (T3). Dry-run unless --apply. No environment-variable reads; secrets only from files.
//   node scripts/sandbox-e2e.ts setup|matrix [--rows R1,R2] --token-file <p> [--apply]
//     [--w6w <url>] [--cohost-api <url>] [--out <artifacts/e2e dir>] [--auth-emulator <url>]
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSandbox } from "./sandbox-guard.ts";

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
    if (!res.ok) throw new Error(`${method} ${new URL(url).pathname} -> ${res.status}`);
    try { return JSON.parse(text); } catch { return text; }
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

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) { console.log(USAGE); return 0; }
  let o: Opts;
  try { o = parseArgs(argv); } catch (e) { console.error((e as Error).message); return 1; }
  if (o.cmd !== "setup" && o.cmd !== "matrix") { console.error(USAGE); return 1; }
  const h = new Harness(o);
  console.log(`${o.cmd}: ${o.apply ? "APPLY" : "dry-run"} w6w=${h.w6w} cohost=${h.cohostApi} rows=${o.rows.join(",")}`);
  // TODO(T3 later slices): setup = backup/build/install tenant apps, connections, workflow publish;
  // matrix = per-row steps via h.record(row, expected, step).
  console.log("stub: no steps implemented in S1");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
