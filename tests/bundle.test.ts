// Checks the built W6W apps in the build folder (FLITE_BUILD_DIR, default dist/; run `npm run build` first, or `npm run test:bundle`): each is
// a standalone bundle with no imports, its manifest and definitions pass the W6W validator, and
// its actions run from the bundle. The W6W sandbox itself is Deno-only and is not exercised here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ActionDefinition, AppDefinition, AuthDefinition, HookContext } from "@w6w/types";
import { context, order, source } from "./fixtures.ts";
import { readCapture } from "./live-fixtures.ts";
import { buildDir } from "../scripts/build-dir.ts";

/**
 * The validator imports values from @w6w/types, which npm ships as TypeScript source, and Node
 * will not strip types under node_modules. esbuild bundles the two into JavaScript Node can load.
 */
async function loadValidator(): Promise<typeof import("@w6w/validator")> {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(import.meta.resolve("@w6w/validator"))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "warning",
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);
}
const { validateAction, validateApp, validateAuth } = await loadValidator();

const dist = buildDir();
const pack = JSON.parse(readFileSync(new URL("w6w-pack.json", dist), "utf8")) as { apps: Array<{ path: string }> };

async function load(path: string) {
  const dir = new URL(`${path.replace(/^\.\//, "")}/`, dist);
  const pkg = JSON.parse(readFileSync(new URL("package.json", dir), "utf8"));
  const code = readFileSync(new URL(pkg.main, dir), "utf8");
  const app = (await import(new URL(pkg.main, dir).href)).default as AppDefinition;
  // The fields the W6W loader reads from package.json (runtime/src/loader.ts manifestFromPackageJson).
  const manifest = {
    manifestVersion: pkg.w6w.manifestVersion ?? "1",
    id: pkg.w6w.id,
    name: pkg.name,
    displayName: pkg.w6w.displayName,
    version: pkg.version,
    description: pkg.description,
    categories: pkg.w6w.categories,
    appearance: pkg.w6w.appearance,
    author: pkg.author,
    license: pkg.license,
    network: pkg.w6w.network,
  };
  return { pkg, code, app, manifest };
}

type LoadedBundle = Awaited<ReturnType<typeof load>>;
const apps: Record<string, LoadedBundle> = Object.fromEntries(
  await Promise.all(pack.apps.map(async ({ path }) => [path.split("/").pop()!, await load(path)] as const)),
);

for (const [name, { pkg, code, app, manifest }] of Object.entries(apps)) {
  test(`${name}: standalone bundle with no dependencies or imports`, () => {
    assert.equal(pkg.dependencies, undefined);
    assert.doesNotMatch(code, /^\s*import\s|\bimport\(|require\(/m);
    assert.doesNotMatch(code, /@cohost\/flite-types|@w6w\//);
  });

  test(`${name}: manifest, actions and auth pass the W6W validator`, () => {
    const result = validateApp(manifest);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    for (const action of app.actions ?? []) {
      const checked = validateAction(action);
      assert.equal(checked.ok, true, `${(action as ActionDefinition).key}: ${JSON.stringify(checked.errors)}`);
    }
    for (const auth of (app.auth ?? []) as AuthDefinition[]) {
      const checked = validateAuth(auth);
      assert.equal(checked.ok, true, `${auth.key}: ${JSON.stringify(checked.errors)}`);
    }
  });
}

const action = (name: string, key: string) => {
  const found = (apps[name].app.actions ?? []).find((a: unknown) => (a as ActionDefinition).key === key);
  assert.ok(found, `${name} has ${key}`);
  return found as ActionDefinition<any>;
};

test("flite bundle: actions and network allow-list", async () => {
  assert.deepEqual(apps.flite.app.actions?.map((a: unknown) => (a as ActionDefinition).key), [
    "list-organizations", "list-events", "get-event", "create-event", "update-event", "control-event", "delete-event",
    "get-ticket", "create-ticket", "update-ticket", "delete-ticket", "list-orders", "get-order", "validate-ticket",
    "check-in-ticket", "get-webhook", "register-webhook",
  ]);
  assert.deepEqual(apps.flite.app.auth?.map((auth) => auth.key), ["partner-login", "partner-login-staging", "bearer-token", "bearer-token-staging"]);
  assert.equal(apps.flite.app.triggers?.length, 1);
  assert.deepEqual(apps.flite.manifest.network.allow, ["api-main.fliteapi.city", "api-staging.fliteapi.city"]);
  const { ctx, requests } = context([{ success: true, data: order }]);
  const result = await action("flite", "get-order").execute({ orderId: "order_1" }, ctx as HookContext);
  assert.equal((result as { order: { _id: string } }).order._id, "order_1");
  assert.equal(new URL(requests[0].url).hostname, "api-main.fliteapi.city");
});

test("transformer bundle: offline conversions in both directions", async () => {
  const transformer = apps["cohost-flite-transformer"];
  assert.equal(transformer.app.actions?.length, 6);
  assert.equal(transformer.app.auth, undefined);
  assert.deepEqual(transformer.manifest.network.allow, []);
  const flite = readCapture<{ data: { _id: string; eventName: string } }>("event-1-with-tickets").body.data;
  const { data, tickets } = await action("cohost-flite-transformer", "flite-to-cohost")
    .execute({ ...source, resource: "event", data: flite }, {} as HookContext) as { data: unknown; tickets: unknown[] };
  assert.equal(tickets.length, 2);
  const back = await action("cohost-flite-transformer", "cohost-to-flite-data")
    .execute({ resource: "event", data }, {} as HookContext) as { data: { eventId: string; eventName: string } };
  assert.deepEqual([back.data.eventId, back.data.eventName], [flite._id, flite.eventName]);
  const converted = await action("cohost-flite-transformer", "cohost-to-flite").execute({
    resource: "ticket",
    data: { status: "live", costs: { cost: "USD,1234" }, capacity: 100 },
    eventId: "event_test",
    ticketId: "ticket_test",
  }, {} as HookContext);
  assert.deepEqual(converted, {
    actionKey: "update-ticket",
    params: { eventId: "event_test", ticketId: "ticket_test", availability: "true", capacity: 100, ticketPrice: 12.34 },
  });
});
