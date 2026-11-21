import { test } from "node:test";
import assert from "node:assert/strict";
import type { FlitePartnerSession } from "@cohost/flite-types";
import {
  credentialFrom,
  type FlitePartnerCredential,
  pickOrganization,
  production,
  REFRESH_MARGIN_MS,
  staging,
} from "../auth/partner-session.ts";
import { API_URL, baseUrl, STAGING_API_URL } from "../lib/client.ts";
import { context } from "../../../tests/fixtures.ts";
import { readCapture, replayCapture } from "../../../tests/live-fixtures.ts";

const DAY = 86_400_000;
const login = readCapture<{ data: FlitePartnerSession }>("login");
const refreshed = readCapture<{ data: FlitePartnerSession }>("partner-refresh-token");
const orgId = login.body.data.user.organization._id;

function headers(init: RequestInit): Headers {
  return new Headers(init.headers);
}

function credential(overrides: Partial<FlitePartnerCredential> = {}): FlitePartnerCredential {
  return { ...credentialFrom(login.body, Date.parse("2026-11-13T00:00:00Z")), ...overrides };
}

test("a login response becomes a credential that refreshes a day before the token expires", () => {
  const now = Date.parse("2026-11-13T00:00:00Z");
  const value = credentialFrom(login.body, now);
  assert.equal(value.token, "fixture-token");
  assert.equal(value.refreshToken, "fixture-refreshToken");
  assert.equal(value.tokenExpiresAt, new Date(now + 7 * DAY).toISOString());
  assert.equal(value.expiresAt, new Date(now + 7 * DAY - REFRESH_MARGIN_MS).toISOString());
  assert.equal(value.refreshTokenExpiresAt, login.body.data.refreshTokenExpiresAt);
  assert.equal(value.organizationId, orgId);
  assert.equal(value.organizationName, login.body.data.user.organization.name);
  assert.equal(value.email, login.body.data.user.email);
});

test("a replayed refresh reports the remaining lifetime; the margin never exceeds half of it", () => {
  const now = Date.parse("2026-11-13T00:00:00Z");
  const short = { ...refreshed.body, data: { ...refreshed.body.data, expiresIn: 3600 } };
  const value = credentialFrom(short, now);
  assert.equal(value.tokenExpiresAt, new Date(now + 3_600_000).toISOString());
  assert.equal(value.expiresAt, new Date(now + 1_800_000).toISOString());
});

test("malformed session responses are rejected", () => {
  const data = login.body.data;
  assert.throws(() => credentialFrom({ success: false }), /partner session/);
  assert.throws(() => credentialFrom({ success: true, data: { ...data, refreshToken: "" } }), /refresh token/);
  assert.throws(() => credentialFrom({ success: true, data: { ...data, token: "a\r\nb" } }), /access token/);
  assert.throws(() => credentialFrom({ success: true, data: { ...data, expiresIn: 0 } }), /lifetime/);
});

test("connect signs in once with JSON, sends no Authorization header, and stores no password", async () => {
  const { ctx, requests } = context([replayCapture("login")]);
  const value = await production.exchange!({ fields: { email: " pilot@example.com ", password: "s3cret" } }, ctx);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${API_URL}/partner-login`);
  assert.equal(requests[0].init.method, "POST");
  assert.equal(headers(requests[0].init).get("content-type"), "application/json");
  assert.equal(headers(requests[0].init).get("authorization"), null);
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { email: "pilot@example.com", password: "s3cret" });
  assert.equal(JSON.stringify(value).includes("s3cret"), false);
  assert.equal((value as FlitePartnerCredential).refreshToken, "fixture-refreshToken");
});

test("connect requires email and password, and reports Flite's code without its message", async () => {
  await assert.rejects(async () => await production.exchange!({ fields: { email: "pilot@example.com" } }, context().ctx), /required/);
  const { ctx } = context([Response.json({ success: false, message: "Account blocked: pilot@example.com", code: "account_disabled" }, { status: 403 })]);
  await assert.rejects(
    async () => await production.exchange!({ fields: { email: "pilot@example.com", password: "x" } }, ctx),
    (error: Error) => error.message === "Flite sign-in failed (account_disabled, HTTP 403)",
  );
});

test("connect stays on the login's organization when it is the one asked for", async () => {
  for (const organization of [orgId, login.body.data.user.organization.name.toUpperCase(), ""]) {
    const { ctx, requests } = context([replayCapture("login")]);
    await production.exchange!({ fields: { email: "a@example.com", password: "x", organization } }, ctx);
    assert.equal(requests.length, 1, organization);
  }
});

test("connect switches the session to another organization by name", async () => {
  const other = { _id: "65f1e00000000000000000aa", ownerId: orgId, name: "Second Org", email: "o@example.com", currency: "usd", tabling: false };
  const switched = { ...refreshed.body, data: { ...refreshed.body.data, refreshToken: "switched-refresh", user: { ...refreshed.body.data.user, organization: { _id: other._id, name: other.name } } } };
  const { ctx, requests } = context([
    replayCapture("login"),
    { success: true, data: [readCapture<{ data: unknown[] }>("organizations-partner").body.data[0], other] },
    switched,
  ]);
  const value = await production.exchange!({ fields: { email: "a@example.com", password: "x", organization: "second org" } }, ctx) as FlitePartnerCredential;
  assert.equal(requests[1].url, `${API_URL}/get-all-orgs-partner`);
  assert.equal(headers(requests[1].init).get("authorization"), "Bearer fixture-token");
  assert.equal(requests[2].url, `${API_URL}/switch-organization-token/${other._id}`);
  assert.equal(requests[2].init.method, "POST");
  assert.equal(requests[2].init.body, undefined);
  assert.equal(headers(requests[2].init).get("authorization"), "Bearer fixture-token");
  assert.equal(requests.length, 3, "the login's refresh token is left to lapse, not revoked");
  assert.equal(value.organizationId, other._id);
  assert.equal(value.refreshToken, "switched-refresh");
});

test("organizations are matched by ID or unique name", () => {
  const a = { _id: "65f1e00000000000000000a1", name: "Acme", ownerId: "", email: "", currency: "usd", tabling: false };
  const b = { ...a, _id: "65f1e00000000000000000b2", name: "Beta" };
  assert.equal(pickOrganization([a, b], "beta")._id, b._id);
  assert.equal(pickOrganization([a, b], a._id), a);
  assert.throws(() => pickOrganization([a, b], "Gamma"), /no organization "Gamma" \(it has 2\)/);
  assert.throws(() => pickOrganization([a, { ...b, name: "acme" }], "ACME"), /More than one/);
});

test("refresh rotates the session with the stored refresh token only", async () => {
  const { ctx, requests } = context([replayCapture("partner-refresh-token")]);
  const value = await production.refresh!({ credential: credential() }, ctx) as FlitePartnerCredential;
  assert.equal(requests[0].url, `${API_URL}/partner-refresh-token`);
  assert.equal(headers(requests[0].init).get("authorization"), null);
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { refreshToken: "fixture-refreshToken" });
  assert.equal(value.token, "fixture-token");
  assert.ok(Date.parse(value.expiresAt) > Date.now() + 5 * DAY);
});

test("refresh failures carry Flite's code: reused, invalid, missing", async () => {
  for (const [capture, code, status] of [
    ["partner-refresh-token-after-revoke", "refresh_token_reused", 401],
    ["partner-refresh-token-invalid", "invalid_refresh_token", 401],
    ["partner-refresh-token-missing", "refresh_token_required", 400],
  ] as const) {
    const { ctx } = context([replayCapture(capture)]);
    await assert.rejects(
      async () => await production.refresh!({ credential: credential() }, ctx),
      (error: Error) => error.message === `Flite token refresh failed (${code}, HTTP ${status})`,
    );
  }
  await assert.rejects(async () => await production.refresh!({ credential: { token: "pasted" } }, context().ctx), /no refresh token; reconnect/);
});

test("disconnect revokes the session; an already-unknown session counts as revoked", async () => {
  const { ctx, requests } = context([replayCapture("partner-revoke-token"), replayCapture("partner-revoke-token-invalid")]);
  await production.revoke!({ credential: credential() }, ctx);
  await production.revoke!({ credential: credential() }, ctx);
  assert.equal(requests[0].url, `${API_URL}/partner-revoke-token`);
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { refreshToken: "fixture-refreshToken" });
  const failing = context([new Response("", { status: 503 })]);
  await assert.rejects(async () => await production.revoke!({ credential: credential() }, failing.ctx), /HTTP 503/);
});

test("credential test lists organizations with the access token", async () => {
  const { ctx, requests } = context([replayCapture("organizations-partner"), replayCapture("invalid-access-token")]);
  assert.deepEqual(await production.test({ credential: credential() }, ctx), { ok: true });
  assert.equal(headers(requests[0].init).get("authorization"), "Bearer fixture-token");
  const failed = await production.test({ credential: credential() }, ctx);
  assert.equal(failed.ok, false);
  assert.match(failed.message ?? "", /HTTP 401/);
});

test("sign uses the access token, never the refresh token, and only for its own environment", async () => {
  const { ctx } = context();
  const signed = await production.sign!({
    credential: credential(),
    request: { url: `${API_URL}/get-order-by-id`, method: "GET", headers: {} },
  }, ctx);
  assert.equal(signed.headers.authorization, "Bearer fixture-token");
  assert.throws(
    () => staging.sign!({ credential: credential(), request: { url: `${API_URL}/get-order-by-id`, method: "GET", headers: {} } }, ctx),
    /Refusing/,
  );
});

test("staging partner sessions talk to staging; the label shows account and organization", async () => {
  const { ctx, requests } = context([replayCapture("login")]);
  await staging.exchange!({ fields: { email: "a@example.com", password: "x" } }, ctx);
  assert.equal(requests[0].url, `${STAGING_API_URL}/partner-login`);
  const connection = { ...ctx.connection!, auth: "partner-login-staging" };
  assert.equal(baseUrl({ connection }), STAGING_API_URL);
  assert.equal(baseUrl({ connection: { ...connection, auth: "partner-login" } }), API_URL);
  assert.deepEqual(await production.afterConnect!({ credential: credential() }, ctx), {
    email: login.body.data.user.email,
    organization: login.body.data.user.organization.name,
  });
});
