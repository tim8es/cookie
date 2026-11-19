import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

import type { IdentitySessions } from "../../../packages/platform-identity/src/index.js";
import { createApp } from "../src/app.js";

test("identity provider state is private to an identity bearer", async (t) => {
  const provider = {} as IdentitySessions;
  const app = createApp(
    { query: async () => ({ rows: [] }) },
    {
      identitySessionProviders: [provider],
      identitySessionPool: {} as Pool,
    },
  );
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/auth/identity/providers",
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.vary, "Authorization");
});

test("browser continuity verifies a global bearer and resumes without replay", async (t) => {
  const token = "is_" + "A".repeat(43);
  const expiry = Math.floor(Date.now() / 1000) + 120;
  let revoked = false;
  const provider = {
    async resolveWithExpiry(input: string) {
      return input === token && !revoked
        ? {
            identityId: "11111111-1111-4111-8111-111111111111",
            expiresAtUnixSeconds: expiry,
          }
        : null;
    },
    async revoke(input: string) {
      if (input === token) revoked = true;
    },
  } as unknown as IdentitySessions;
  const app = createApp(
    { query: async () => ({ rows: [] }) },
    { identitySessionProviders: [provider] },
  );
  t.after(() => app.close());
  const browser = { "sec-fetch-site": "same-origin", "x-kuki-session": "1" };
  const path = "/v1/auth/browser-session";
  const unauthorized = await app.inject({
    method: "POST",
    url: path,
    headers: browser,
  });
  assert.equal(unauthorized.statusCode, 401);
  const crossSite = await app.inject({
    method: "POST",
    url: path,
    headers: {
      ...browser,
      "sec-fetch-site": "cross-site",
      authorization: "Bearer " + token,
    },
  });
  assert.equal(crossSite.statusCode, 403);
  assert.equal(crossSite.headers["set-cookie"], undefined);
  const bound = await app.inject({
    method: "POST",
    url: path,
    headers: { ...browser, authorization: "Bearer " + token },
  });
  assert.equal(bound.statusCode, 204);
  const cookie = String(bound.headers["set-cookie"]);
  assert.match(cookie, /^__Host-kuki-session=is_/);
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.equal(bound.headers["cache-control"], "no-store");
  const header = cookie.split(";", 1)[0]!;
  const resumed = await app.inject({
    method: "GET",
    url: path,
    headers: { ...browser, cookie: header },
  });
  assert.equal(resumed.statusCode, 200);
  assert.deepEqual(resumed.json(), {
    tokenType: "Bearer",
    accessToken: token,
    scope: "identity",
    expiresAtUnixSeconds: expiry,
  });
  assert.equal(resumed.headers["cache-control"], "no-store");
  const denied = await app.inject({
    method: "GET",
    url: path,
    headers: { ...browser, "sec-fetch-site": "same-site", cookie: header },
  });
  assert.equal(denied.statusCode, 403);
  const duplicate = await app.inject({
    method: "GET",
    url: path,
    headers: { ...browser, cookie: header + "; " + header },
  });
  assert.equal(duplicate.statusCode, 401);
  const logout = await app.inject({
    method: "POST",
    url: "/v1/auth/identity/logout",
    headers: {
      ...browser,
      authorization: "Bearer " + token,
      cookie: header,
    },
  });
  assert.equal(logout.statusCode, 204);
  assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);
  const after = await app.inject({
    method: "GET",
    url: path,
    headers: { ...browser, cookie: header },
  });
  assert.equal(after.statusCode, 401);
});

test("renewal is opt-in, cookie-bound and does not accept a lifetime from the browser", async (t) => {
  const token = "is_" + "A".repeat(43);
  const expires = Math.floor(Date.now() / 1000) + 120;
  const calls: { token: string; lifetime: number }[] = [];
  const provider = {
    async resolveWithExpiry(value: string) {
      return value === token
        ? {
            identityId: "11111111-1111-4111-8111-111111111111",
            expiresAtUnixSeconds: expires,
          }
        : null;
    },
    async renewWithinAbsoluteLifetime(value: string, lifetime: number) {
      calls.push({ token: value, lifetime });
      return expires;
    },
  } as unknown as IdentitySessions;
  const database = { query: async () => ({ rows: [] }) };
  const disabled = createApp(database, {
    identitySessionProviders: [provider],
  });
  t.after(() => disabled.close());
  const app = createApp(database, {
    identitySessionProviders: [provider],
    browserSessionRenewalAbsoluteLifetimeSeconds: 3600,
  });
  t.after(() => app.close());
  const path = "/v1/auth/browser-session/renew";
  const headers = {
    "sec-fetch-site": "same-origin",
    "x-kuki-session": "1",
    authorization: "Bearer " + token,
    cookie: "__Host-kuki-session=" + token,
  };
  const off = await disabled.inject({ method: "POST", url: path, headers });
  assert.equal(off.statusCode, 404);
  const noCookie = await app.inject({
    method: "POST",
    url: path,
    headers: { ...headers, cookie: "" },
  });
  assert.equal(noCookie.statusCode, 401);
  const otherAccount = await app.inject({
    method: "POST",
    url: path,
    headers: { ...headers, authorization: "Bearer is_" + "B".repeat(43) },
  });
  assert.equal(otherAccount.statusCode, 401);
  const crossSite = await app.inject({
    method: "POST",
    url: path,
    headers: { ...headers, "sec-fetch-site": "cross-site" },
  });
  assert.equal(crossSite.statusCode, 403);
  const override = await app.inject({
    method: "POST",
    url: path + "?lifetime=9999",
    headers,
  });
  assert.equal(override.statusCode, 400);
  assert.deepEqual(calls, []);
  const allowed = await app.inject({ method: "POST", url: path, headers });
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(calls, [{ token, lifetime: 3600 }]);
  assert.equal(allowed.json().expiresAtUnixSeconds, expires);
  assert.match(
    String(allowed.headers["set-cookie"]),
    /HttpOnly; Secure; SameSite=Strict/,
  );
});
