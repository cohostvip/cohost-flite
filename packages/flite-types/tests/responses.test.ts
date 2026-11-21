import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("Flite response types match the committed JSON samples", () => {
  const script = new URL("../../../scripts/derive-types.mjs", import.meta.url).pathname;
  assert.doesNotThrow(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" }));
});
