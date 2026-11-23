import type { AuthDefinition, SignHook } from "@w6w/types";
import { API_URL, object, STAGING_API_URL } from "../lib/client.ts";

function tokenOf(credential: unknown): string {
  const token = object(credential).token;
  if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)) {
    throw new Error("A Flite bearer token is required");
  }
  return token.trim();
}

const FLITE_HOSTS = new Set([new URL(API_URL).hostname, new URL(STAGING_API_URL).hostname]);

/**
 * `sign` for every Flite auth: the credential's `token`, only to that environment's `/api/`. A
 * request to a host that is not Flite's (the flyer download) goes out unsigned, with any
 * authorization header removed; a request to the other Flite environment, or not over https, is refused.
 */
export function signFliteRequest(base: string): SignHook {
  return ({ request, credential }) => {
    const url = new URL(request.url);
    if (!FLITE_HOSTS.has(url.hostname)) {
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([k]) => k.toLowerCase() !== "authorization"));
      return { ...request, headers };
    }
    if (url.origin !== new URL(base).origin || !url.pathname.startsWith("/api/")) {
      throw new Error("Refusing to send a Flite token to another host or environment");
    }
    request.headers.authorization = `Bearer ${tokenOf(credential)}`;
    return request;
  };
}

/**
 * A pasted partner access token. It expires after 7 days and is not renewed; prefer the
 * `partner-login` auth, which renews itself.
 */
function bearerToken(staging: boolean): AuthDefinition {
  const base = staging ? STAGING_API_URL : API_URL;
  return {
    key: staging ? "bearer-token-staging" : "bearer-token",
    type: "bearer",
    displayName: staging ? "Bearer Token (Staging)" : "Bearer Token (Production)",
    description:
      "Paste a Flite partner access token scoped to the organization you want to manage. It " +
      "expires after 7 days; use Flite Account instead to stay connected.",
    fields: [{ key: "token", label: "Bearer token", type: "secret", required: true }],
    sign: signFliteRequest(base),
    async test({ credential }, ctx) {
      const response = await ctx.fetch(`${base}/get-all-orgs-partner`, {
        headers: { authorization: `Bearer ${tokenOf(credential)}` },
      });
      if (!response.ok) return { ok: false, message: `Flite returned HTTP ${response.status}` };
      const body = object(await response.json());
      return body.success === true
        ? { ok: true }
        : { ok: false, message: "Flite rejected the credential check" };
    },
  };
}

export const production = bearerToken(false);
export const staging = bearerToken(true);
