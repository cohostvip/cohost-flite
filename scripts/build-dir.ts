// Where `npm run build` writes the W6W pack. Set FLITE_BUILD_DIR in .env.local (or the
// environment) to an absolute path or one relative to the repo root; defaults to dist/.
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/** Loads the repo's `.env.local`, if any. Never overrides variables already set. */
export function loadLocalEnv(): void {
  const envFile = resolve(repoRoot, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

export function buildDir(): URL {
  loadLocalEnv();
  const dir = resolve(repoRoot, process.env.FLITE_BUILD_DIR?.trim() || "dist");
  return pathToFileURL(`${dir}/`);
}

/** The build deletes the folder first: allow that only for an empty folder or a previous pack. */
export function assertSafeToReplace(dir: URL): void {
  const path = fileURLToPath(dir);
  if (!existsSync(path)) return;
  const entries = readdirSync(path);
  if (entries.length === 0 || entries.includes("w6w-pack.json")) return;
  throw new Error(
    `Refusing to replace ${path}: it is not empty and holds no w6w-pack.json. Check FLITE_BUILD_DIR.`,
  );
}
