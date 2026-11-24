/** Content digest of a desired Flite state: `v1:` + SHA-256 hex of a canonical JSON. */

import { sha256Hex } from "./sha256.ts";

export const DIGEST_VERSION = "v1";

/** JSON with object keys sorted at every depth; `undefined` members are dropped like JSON.stringify does. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .filter((k) => rec[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function digestOf(value: unknown): string {
  return `${DIGEST_VERSION}:${sha256Hex(canonicalJson(value))}`;
}
