import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { createApp } from "../src/app.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const IDENTITY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOCATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const base = `/v1/organizations/${TENANT}`;
const mockDatabase = { query: async () => ({ rows: [] }) };

test("no workspace or schedule routes exist in ordinary API composition", async (t) => {
  const app = createApp(mockDatabase);
  t.after(async () => app.close());
  const schedule = `${base}/locations/${LOCATION}/staff/${STAFF}/schedule`;
  for (const url of [base + "/workspace-context", schedule]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 404);
  }
});

test("workspace read-only routes require verified session and guard tenant scope", async (t) => {
  const app = createApp(mockDatabase, {
    syntheticWorkspaceReads: {
      pool: {} as Pool,
      verifier: {
        verifyBearerToken: async (token) =>
          token === "fixture"
            ? {
                identityId: IDENTITY,
                tenantId: TENANT,
                expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 600,
              }
            : null,
      },
    },
  });
  t.after(async () => app.close());
  const workspace = base + "/workspace-context";
  const noAuth = await app.inject({ method: "GET", url: workspace });
  assert.equal(noAuth.statusCode, 401);
  assert.equal(noAuth.json().error.code, "UNAUTHENTICATED");

  const foreign = await app.inject({
    method: "GET",
    url: `/v1/organizations/${OTHER}/workspace-context`,
    headers: { authorization: "Bearer fixture" },
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.json().error.code, "ACCESS_DENIED");

  const schedule = `${base}/locations/${LOCATION}/staff/${STAFF}/schedule`;
  // A correctly formed v4 UUID and a valid UTC range pass input parsing.
  // The mock does not supply a DB client; a 503 proves validation did not
  // incorrectly reject the identifiers with a 400 before reaching storage.
  const accepted = await app.inject({
    method: "GET",
    url: schedule + "?from=2027-04-12T10:00:00Z&to=2027-04-12T11:00:00Z",
    headers: { authorization: "Bearer fixture" },
  });
  assert.equal(accepted.statusCode, 503);
  assert.equal(accepted.json().error.code, "BACKEND_UNAVAILABLE");

  for (const url of [
    schedule + "?from=2027-04-12T10:00:00Z&to=2027-04-12T09:00:00Z",
    schedule + "?from=2027-04-12T10:00:00+03:00&to=2027-04-12T11:00:00Z",
    schedule + "?from=2027-04-12T10:00:00Z&to=2027-05-12T11:00:00Z",
    `${base}/locations/invalid/staff/${STAFF}/schedule?from=2027-04-12T10:00:00Z&to=2027-04-12T11:00:00Z`,
  ]) {
    const response = await app.inject({
      method: "GET",
      url,
      headers: { authorization: "Bearer fixture" },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "INVALID_REQUEST");
  }
});
