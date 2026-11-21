#!/usr/bin/env node
/**
 * Build both apps into a local W6W tenant-apps folder, the same way cohost-w6w does:
 *
 *   <DEPLOY_FOLDER>/index.json                          id, version and digest per app
 *   <DEPLOY_FOLDER>/<app-id>/<version>/{manifest.json, app.js}
 *
 * Usage: node scripts/deploy-local.mjs [--cli <path to w6w.js>]
 *
 * `DEPLOY_FOLDER` comes from the environment or `.env.local` (the same variable and folder as
 * cohost-w6w's `.env.local`). The W6W server registers the folder's apps when it boots.
 * It packs the built apps in the build folder (`FLITE_BUILD_DIR`, default `dist/`; run
 * `npm run build` first, `npm run deploy:local` does): the W6W CLI compiles nothing and only
 * accepts a JavaScript entry, and the sources' entries are TypeScript.
 *
 * Each app goes through `w6w build app` into a temporary folder, never straight into
 * DEPLOY_FOLDER: the CLI's `--out` rewrites `<out>/index.json` with only the app it built, which
 * would drop every other app in the tenant folder. This script then copies the app's
 * `<id>/<version>/` into DEPLOY_FOLDER and inserts or updates only that app's `index.json` entry.
 * Other apps and their entries are left as they are.
 *
 * The CLI is `--cli` / `W6W_CLI` (a w6w.js run with node), else `w6w` on PATH.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDir, loadLocalEnv, repoRoot } from "./build-dir.ts";

function fail(message) {
  console.error(`deploy-local: ${message}`);
  process.exit(2);
}

let cli = process.env.W6W_CLI;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--cli") cli = argv[++i];
  else if (argv[i] === "-h" || argv[i] === "--help") {
    console.log("usage: node scripts/deploy-local.mjs [--cli <path to w6w.js>]");
    process.exit(0);
  } else fail(`unknown argument: ${argv[i]}`);
}

loadLocalEnv();
const folder = process.env.DEPLOY_FOLDER?.trim();
if (!folder) fail("DEPLOY_FOLDER is not set (environment or .env.local)");
const out = resolve(repoRoot, folder);
const index = join(out, "index.json");
const tenant = existsSync(index) ? JSON.parse(readFileSync(index, "utf8")) : { apps: [] };
if (!Array.isArray(tenant.apps)) fail(`${index} has no apps array; is DEPLOY_FOLDER a tenant-apps folder?`);

const [cmd, prefix] = cli ? [process.execPath, [resolve(cli)]] : ["w6w", []];
const built = fileURLToPath(buildDir());
const packFile = join(built, "w6w-pack.json");
if (!existsSync(packFile)) fail(`${packFile} is missing; run npm run build first`);
const pack = JSON.parse(readFileSync(packFile, "utf8"));

const staging = mkdtempSync(join(tmpdir(), "flite-deploy-"));
try {
  const entries = [];
  for (const { path } of pack.apps) {
    const appDir = resolve(built, path);
    const scratch = join(staging, String(entries.length));
    const r = spawnSync(cmd, [...prefix, "build", "app", appDir, "--out", scratch], { stdio: "inherit" });
    if (r.error) fail(`could not run ${cmd}: ${r.error.message}`);
    if (r.status !== 0) process.exit(r.status ?? 1);
    const [entry, ...extra] = JSON.parse(readFileSync(join(scratch, "index.json"), "utf8")).apps ?? [];
    if (!entry?.id || !entry?.version || extra.length) fail(`unexpected build index for ${path}`);
    entries.push({ entry, files: join(scratch, entry.id, entry.version) });
  }
  // Copy only after every app built, so a failed build leaves the tenant folder untouched.
  for (const { entry, files } of entries) {
    const target = join(out, entry.id, entry.version);
    rmSync(target, { recursive: true, force: true });
    cpSync(files, target, { recursive: true });
    const at = tenant.apps.findIndex((app) => app.id === entry.id);
    if (at === -1) tenant.apps.push(entry);
    else tenant.apps[at] = entry;
    console.log(`deployed ${entry.id}@${entry.version} -> ${target}`);
  }
  const next = `${index}.${process.pid}.tmp`;
  writeFileSync(next, `${JSON.stringify(tenant, null, 2)}\n`);
  renameSync(next, index);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log(`deployed ${pack.apps.length} apps into ${out}`);
