// `npm run build`: the release pack, in the build folder (FLITE_BUILD_DIR, default dist/).
// For each app in w6w-pack.json, esbuild bundles its source entry (`w6w.entry`) into one
// dependency-free ESM `app.js`, next to a package.json whose `main` and `w6w.entry` name it, the
// app's assets, README and the repo LICENSE. The W6W CLI compiles nothing, so this is the only
// build: `deploy:local`, `test:bundle` and installs all use its output.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { assertSafeToReplace, buildDir, repoRoot } from "./build-dir.ts";

const root = new URL("../", import.meta.url);
const dist = buildDir();
assertSafeToReplace(dist);
const pack = JSON.parse(await readFile(new URL("w6w-pack.json", root), "utf8"));
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const entry of pack.apps) {
  const source = new URL(`${entry.path}/`, root);
  const target = new URL(`${entry.path}/`, dist);
  const pkg = JSON.parse(await readFile(new URL("package.json", source), "utf8"));
  await build({
    entryPoints: [fileURLToPath(new URL(pkg.w6w.entry, source))],
    outfile: fileURLToPath(new URL("app.js", target)),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    logLevel: "warning",
    // Source-path comments are relative to this, so every build of an app is byte-identical.
    absWorkingDir: repoRoot,
  });
  // W6W rejects dependency declarations; every app ships a complete standalone bundle.
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    author: pkg.author,
    type: "module",
    main: "./app.js",
    w6w: { ...pkg.w6w, entry: "./app.js" },
  };
  await writeFile(new URL("package.json", target), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const path of ["assets", "README.md"]) {
    await cp(new URL(path, source), new URL(path, target), { recursive: true });
  }
  await cp(new URL("LICENSE", root), new URL("LICENSE", target));
}
await writeFile(new URL("w6w-pack.json", dist), `${JSON.stringify(pack, null, 2)}\n`);
await cp(new URL("README.md", root), new URL("README.md", dist));
console.log(`Built W6W pack in ${fileURLToPath(dist)} with ${pack.apps.length} standalone, dependency-free apps.`);
