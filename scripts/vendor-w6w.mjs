// Copies @w6w/validator into vendor/w6w/validator, pinned to one w6w-core commit. It is on neither
// npm nor JSR yet. @w6w/types comes from npm; the pin is the commit tagged types-v0.2.0, so the
// validator matches the installed @w6w/types@0.2.0. Bump both together. Pure TypeScript whose only
// import is @w6w/types.
//
//   node scripts/vendor-w6w.mjs   refresh vendor/w6w from the pinned commit (needs network)
import fs from "node:fs/promises";

const COMMIT = "05a20b86bedffc406877817ca79b29173e9aceac"; // types-v0.2.0
const VERSION = "0.2.0";
const root = new URL("../vendor/w6w/", import.meta.url);
const target = new URL("validator/", root);
const api = `https://api.github.com/repos/w6w-io/w6w-core/git/trees/${COMMIT}?recursive=1`;
const raw = (path) => `https://raw.githubusercontent.com/w6w-io/w6w-core/${COMMIT}/${path}`;

async function download(path) {
  const response = await fetch(raw(path));
  if (!response.ok) throw new Error(`${response.status} for ${path}`);
  return response.text();
}

const tree = await (await fetch(api, { headers: { accept: "application/vnd.github+json" } })).json();
if (!Array.isArray(tree.tree)) throw new Error(`Could not list w6w-core@${COMMIT}: ${JSON.stringify(tree).slice(0, 200)}`);
const prefix = "packages/validator/";
const files = tree.tree.filter((e) => e.type === "blob" && e.path.startsWith(prefix))
  .map((e) => e.path.slice(prefix.length))
  .filter((p) => p === "mod.ts" || (p.startsWith("src/") && p.endsWith(".ts")));
if (!files.includes("mod.ts")) throw new Error(`w6w-core@${COMMIT} has no ${prefix}mod.ts`);

await fs.rm(root, { recursive: true, force: true });
for (const file of files) {
  const out = new URL(file, target);
  await fs.mkdir(new URL(".", out), { recursive: true });
  await fs.writeFile(out, await download(prefix + file));
}
// The package has no LICENSE of its own; w6w-core's root one (MIT) covers it.
await fs.writeFile(new URL("LICENSE", target), await download("LICENSE"));
const manifest = {
  name: "@w6w/validator",
  version: VERSION,
  private: true,
  license: "MIT",
  type: "module",
  description: `Vendored from w6w-io/w6w-core@${COMMIT} by scripts/vendor-w6w.mjs. Do not edit.`,
  types: "./mod.ts",
  exports: { ".": "./mod.ts" },
};
await fs.writeFile(new URL("package.json", target), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Vendored @w6w/validator@${VERSION} (${files.length} files)`);
