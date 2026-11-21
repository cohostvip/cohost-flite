import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSandbox, sandboxAuthKey } from "../scripts/sandbox-guard.ts";

test("assertSandbox rejects non-sandbox urls", () => {
  for (const u of [
    "https://api-main.fliteapi.city/v1/x",
    "https://api-staging.fliteapi.city.evil.com/v1/x",
    "http://api-staging.fliteapi.city/v1/x",
    "https://evil.com/api-staging.fliteapi.city",
    "not a url",
  ]) assert.throws(() => assertSandbox(u), u);
});
test("sandboxAuthKey rejects production key", () => {
  assert.throws(() => sandboxAuthKey("partner-login"));
  assert.throws(() => sandboxAuthKey("partner-login-staging-x"));
});
test("good pair passes", () => {
  assert.equal(assertSandbox("https://api-staging.fliteapi.city/v1/events").hostname, "api-staging.fliteapi.city");
  assert.equal(sandboxAuthKey("partner-login-staging"), "partner-login-staging");
});
