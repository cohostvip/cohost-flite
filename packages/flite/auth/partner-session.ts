import type { AuthDefinition, HookContext } from "@w6w/types";
import type { FliteOrganization, FlitePartnerSession } from "@cohost/flite-types";
import { API_URL, object, STAGING_API_URL } from "../lib/client.ts";
import { signFliteRequest } from "./bearer-token.ts";

/**
 * The stored credential of a partner-session connection. The account password is used once, at
 * connect time, and never stored. The host calls `refresh` once `expiresAt` comes due and stores
 * what it returns in place of this.
 */
export interface FlitePartnerCredential {
  /** Access token (JWT) for `Authorization: Bearer`. */
  token: string;
  /** Rotates on every refresh; the previous one replays the same pair for 5 minutes. */
  refreshToken: string;
  /** When the host should refresh: ahead of the access token's own expiry. ISO 8601. */
  expiresAt: string;
  /** When the access token itself expires. ISO 8601. */
  tokenExpiresAt: string;
  /** When the refresh token expires. Past this, the connection must sign in again. ISO 8601. */
  refreshTokenExpiresAt: string;
  organizationId: string;
  organizationName: string;
  email: string;
}

/** Refresh this long before the access token expires (at most half its remaining life). */
export const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

type Fetch = HookContext["fetch"];

/** Flite's auth failures carry a machine `code`; never echo the rest of the body. */
async function failure(response: Response, what: string): Promise<Error> {
  let code: unknown;
  try {
    code = object(await response.json()).code;
  } catch {
    // Not JSON: the status alone describes it.
  }
  const detail = typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? `${code}, ` : "";
  return new Error(`Flite ${what} failed (${detail}HTTP ${response.status})`);
}

async function post(fetch: Fetch, url: string, body: unknown, token?: string): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Validates a login/refresh/switch response and turns it into the stored credential. */
export function credentialFrom(payload: unknown, now = Date.now()): FlitePartnerCredential {
  const body = object(payload);
  if (body.success !== true) throw new Error("Flite did not return a partner session");
  const data = object(body.data) as unknown as FlitePartnerSession;
  const { token, refreshToken, expiresIn, refreshTokenExpiresIn } = data;
  if (typeof token !== "string" || !token || /[\r\n]/.test(token)) {
    throw new Error("Flite returned no access token");
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new Error("Flite returned no refresh token");
  }
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error("Flite returned no token lifetime");
  const user = object(data.user);
  const organization = object(user.organization);
  // A replayed refresh answers with the remaining lifetime, so always count from now.
  const lifetime = expiresIn * 1000;
  const refreshExpiry = typeof data.refreshTokenExpiresAt === "string" && !Number.isNaN(Date.parse(data.refreshTokenExpiresAt))
    ? new Date(data.refreshTokenExpiresAt).toISOString()
    : new Date(now + (Number(refreshTokenExpiresIn) || 0) * 1000).toISOString();
  return {
    token,
    refreshToken,
    expiresAt: new Date(now + lifetime - Math.min(REFRESH_MARGIN_MS, lifetime / 2)).toISOString(),
    tokenExpiresAt: new Date(now + lifetime).toISOString(),
    refreshTokenExpiresAt: refreshExpiry,
    organizationId: String(organization._id ?? ""),
    organizationName: String(organization.name ?? ""),
    email: String(user.email ?? ""),
  };
}

function stored(credential: unknown): FlitePartnerCredential {
  const value = object(credential);
  if (typeof value.refreshToken !== "string" || !value.refreshToken) {
    throw new Error("This Flite connection has no refresh token; reconnect it");
  }
  return value as unknown as FlitePartnerCredential;
}

export async function login(fetch: Fetch, base: string, email: string, password: string): Promise<FlitePartnerCredential> {
  const response = await post(fetch, `${base}/partner-login`, { email, password });
  if (!response.ok) throw await failure(response, "sign-in");
  return credentialFrom(await response.json());
}

export async function refresh(fetch: Fetch, base: string, refreshToken: string): Promise<FlitePartnerCredential> {
  const response = await post(fetch, `${base}/partner-refresh-token`, { refreshToken });
  if (!response.ok) throw await failure(response, "token refresh");
  return credentialFrom(await response.json());
}

/** Ends the session. A session Flite no longer knows is already ended. */
export async function revoke(fetch: Fetch, base: string, refreshToken: string): Promise<void> {
  const response = await post(fetch, `${base}/partner-revoke-token`, { refreshToken });
  if (response.ok || response.status === 401) return;
  throw await failure(response, "sign-out");
}

export async function organizations(fetch: Fetch, base: string, token: string): Promise<FliteOrganization[]> {
  const response = await fetch(`${base}/get-all-orgs-partner`, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw await failure(response, "organization list");
  const body = object(await response.json());
  if (body.success !== true || !Array.isArray(body.data)) throw new Error("Flite returned an invalid organization list");
  return body.data as FliteOrganization[];
}

/** Moves this session to another organization; Flite issues a new pair for it. */
export async function switchOrganization(
  fetch: Fetch,
  base: string,
  token: string,
  organizationId: string,
): Promise<FlitePartnerCredential> {
  if (!/^[a-f0-9]{24}$/i.test(organizationId)) throw new Error("Invalid Flite organization ID");
  const response = await post(fetch, `${base}/switch-organization-token/${organizationId}`, undefined, token);
  if (!response.ok) throw await failure(response, "organization switch");
  return credentialFrom(await response.json());
}

/** Finds an organization by ID or by name (case-insensitive). */
export function pickOrganization(list: FliteOrganization[], wanted: string): FliteOrganization {
  const key = wanted.trim();
  const byId = list.find((org) => org._id === key);
  if (byId) return byId;
  const byName = list.filter((org) => org.name.trim().toLowerCase() === key.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`More than one Flite organization is named "${key}"; use its ID`);
  throw new Error(`This Flite account has no organization "${key}" (it has ${list.length})`);
}

function partnerSession(staging: boolean): AuthDefinition {
  const base = staging ? STAGING_API_URL : API_URL;
  return {
    key: staging ? "partner-login-staging" : "partner-login",
    type: "custom",
    displayName: staging ? "Flite Account (Staging)" : "Flite Account",
    description:
      "Sign in with a Flite Pilot account. The password is used once to start a partner session " +
      "and is not stored; the session renews itself before its 7-day token expires.",
    connectionLabel: "{{email}} — {{organization}}",
    fields: [
      { key: "email", label: "Email", type: "string", required: true },
      { key: "password", label: "Password", type: "secret", required: true },
      {
        key: "organization",
        label: "Organization",
        type: "string",
        required: false,
        hint: "Name or ID of the Flite organization to manage. Leave blank for the account's first organization.",
      },
    ],
    setup: [
      { text: "Use a verified Flite Pilot account that belongs to the organization you want to connect." },
    ],

    async exchange({ fields }, ctx) {
      const { email, password, organization } = (fields ?? {}) as Record<string, unknown>;
      if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
        throw new Error("Flite email and password are required");
      }
      let credential = await login(ctx.fetch, base, email.trim(), password);
      const wanted = typeof organization === "string" ? organization.trim() : "";
      if (wanted && wanted !== credential.organizationId && wanted.toLowerCase() !== credential.organizationName.toLowerCase()) {
        const target = pickOrganization(await organizations(ctx.fetch, base, credential.token), wanted);
        if (target._id !== credential.organizationId) {
          // Same session, rotated: the login's refresh token lapses by itself after 5 minutes.
          // Revoking it would end this session too.
          credential = await switchOrganization(ctx.fetch, base, credential.token, target._id);
        }
      }
      return credential;
    },

    async refresh({ credential }, ctx) {
      return await refresh(ctx.fetch, base, stored(credential).refreshToken);
    },

    async revoke({ credential }, ctx) {
      await revoke(ctx.fetch, base, stored(credential).refreshToken);
    },

    sign: signFliteRequest(base),

    async test({ credential }, ctx) {
      try {
        await organizations(ctx.fetch, base, stored(credential).token);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "Flite rejected the credential check" };
      }
    },

    afterConnect({ credential }) {
      const value = stored(credential);
      return { email: value.email, organization: value.organizationName || value.organizationId };
    },
  };
}

export const production = partnerSession(false);
export const staging = partnerSession(true);
