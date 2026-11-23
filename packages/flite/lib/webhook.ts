/**
 * Flite Partner Webhook verification (docs/api-docs.md, "Webhooks — Verification").
 *
 * Every delivery carries `X-Flite-Signature: sha256=<hex>` and `X-Flite-Timestamp: <epoch seconds>`,
 * where the signature is `"sha256=" + hmac_sha256_hex(secret, timestamp + "." + body)`. A delivery is
 * accepted only when the timestamp is within five minutes of now (replay window) and the signature
 * matches in constant time.
 *
 * The primitives are a trimmed copy of w6w's `apps/_shared/webhook/mod.ts` (this repo cannot import
 * it). Fail closed: a missing secret, raw body, header or a stale timestamp refuses the delivery.
 * Error text never echoes the secret, a signature or the body. Web Crypto only, no node builtins:
 * it runs inside the trigger-hook sandbox.
 */

const encoder = new TextEncoder();

/** Flite's replay window, in seconds. */
export const TOLERANCE_SECONDS = 300;

/** Case-insensitive header lookup (the host lowercases names; this tolerates either). */
export function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === want) return value;
  }
  return undefined;
}

/** Lowercase hex HMAC-SHA256 of `data` under `secret`. */
export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
  let hex = "";
  for (const b of sig) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Constant-time string equality over the UTF-8 bytes: visits every byte of the longer input and
 * folds a length mismatch into the result. Non-strings are never equal. `("", "")` is `true`, so
 * callers must refuse an empty secret first.
 */
export function timingSafeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (i < x.length ? x[i] : 0) ^ (i < y.length ? y[i] : 0);
  return diff === 0;
}

/** The value Flite puts in `X-Flite-Signature` for this timestamp and body. */
export async function fliteSignature(secret: string, timestamp: string, body: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

export interface SignedCall {
  headers: Record<string, string>;
  rawBody?: unknown;
}

/**
 * Verify a Flite delivery and return the verified body text. Throws unless the secret is set, the
 * raw body and both headers are present, the timestamp is within the replay window and the
 * signature matches.
 *
 * Flite signs the JSON string of the payload (its docs have receivers `JSON.stringify` a parsed
 * body), so the signature is checked against the exact bytes received and, when they differ, the
 * compact re-serialisation of those same bytes. Both are derived from the raw body, never from the
 * host's parsed copy.
 */
export async function verifyFliteDelivery(
  raw: SignedCall,
  secret: unknown,
  nowMs: number = Date.now(),
): Promise<string> {
  if (typeof secret !== "string" || !secret.trim()) {
    throw new Error("Flite delivery refused: the signing secret is not set on this trigger.");
  }
  if (typeof raw?.rawBody !== "string") {
    throw new Error("Flite delivery refused: the raw body is unavailable, so its signature cannot be verified.");
  }
  const body = raw.rawBody;
  const signature = header(raw.headers, "x-flite-signature")?.trim();
  const timestamp = header(raw.headers, "x-flite-timestamp")?.trim();
  if (!signature) throw new Error("Flite delivery refused: X-Flite-Signature is missing.");
  if (!timestamp) throw new Error("Flite delivery refused: X-Flite-Timestamp is missing.");
  const seconds = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || !Number.isFinite(seconds)) {
    throw new Error("Flite delivery refused: X-Flite-Timestamp is not epoch seconds.");
  }
  if (Math.abs(nowMs / 1000 - seconds) > TOLERANCE_SECONDS) {
    throw new Error("Flite delivery refused: the timestamp is outside the five-minute window.");
  }

  const candidates = [body];
  try {
    const compact = JSON.stringify(JSON.parse(body));
    if (compact !== body) candidates.push(compact);
  } catch {
    throw new Error("Flite delivery refused: the body is not JSON.");
  }
  let matched = false;
  for (const candidate of candidates) {
    // Evaluate every candidate (no early exit) so timing does not reveal which form matched.
    if (timingSafeEqual(await fliteSignature(secret.trim(), timestamp, candidate), signature.toLowerCase())) {
      matched = true;
    }
  }
  if (!matched) throw new Error("Flite delivery refused: the signature does not match.");
  return body;
}
