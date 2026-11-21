import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Guards the committed live fixtures against a regeneration that lets real data through.
const dir = new URL("../../../tests/fixtures/live/", import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith(".json"));

function strings(value: unknown, key = "", out: Array<[string, string]> = []): Array<[string, string]> {
  if (Array.isArray(value)) value.forEach((item) => strings(item, key, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) strings(v, k, out);
  } else if (typeof value === "string") out.push([key, value]);
  return out;
}

test("live fixtures exist", () => {
  assert.ok(files.length > 0);
});

for (const file of files) {
  test(`fixture ${file} contains only synthetic identifying values`, () => {
    const raw = readFileSync(new URL(file, dir), "utf8");
    assert.doesNotMatch(raw, /eyJ[A-Za-z0-9_-]{8,}/, "JWT-like token");
    assert.doesNotMatch(raw, /fliteapi|flite\.city|amazonaws|cloudfront/i, "real asset or API host");
    for (const [key, value] of strings(JSON.parse(raw))) {
      if (value.includes("@")) assert.match(value, /@example\.com$/, `${key} must use example.com`);
      if (/^https?:/.test(value)) assert.match(value, /^https:\/\/example\.com\//, `${key} must use example.com`);
      if (/^[a-f0-9]{24}$/.test(value)) assert.match(value, /^65f1e/, `${key} must be a synthetic ObjectId`);
      if (key === "mobileNumber") assert.match(value, /^\+120255501\d\d$/, "phone must be in the 555-01xx range");
      if (/token$/i.test(key)) assert.match(value, /^fixture-/, `${key} must be a placeholder`);
    }
  });
}
