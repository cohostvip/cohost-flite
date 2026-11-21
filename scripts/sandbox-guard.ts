// Sandbox-only guard: every Flite request of the E2E harness must pass assertSandbox first.
export const SANDBOX_HOST = "api-staging.fliteapi.city";

/** Throws unless url is https://api-staging.fliteapi.city (exact hostname). */
export function assertSandbox(url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("assertSandbox: unparseable URL"); }
  if (u.protocol !== "https:") throw new Error(`assertSandbox: protocol must be https: (got ${u.protocol})`);
  if (u.hostname !== SANDBOX_HOST) throw new Error(`assertSandbox: host must be exactly ${SANDBOX_HOST} (got ${u.hostname})`);
  return u;
}

/** Throws unless the Flite auth key names the staging partner login. */
export function sandboxAuthKey(key: string): string {
  if (typeof key !== "string" || !key.endsWith("-staging")) throw new Error("sandboxAuthKey: auth key must end with -staging");
  return key;
}
