import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import Fastify from "fastify";
import type { Pool } from "pg";

import { createBrandConfig } from "../../../packages/domain-appearance/src/index.js";
import { registerRealAppearanceRoutes } from "../src/appearance-http.js";

test("Appearance owner HTTP boundary fails closed without real authorization", async () => {
  const tenantId = randomUUID();
  const foreignId = randomUUID();
  const identityId = randomUUID();
  let dbConnections = 0;
  const pool = {
    connect() {
      dbConnections += 1;
      throw new Error("Test DB must not be touched on denied input");
    },
  } as unknown as Pool;
  const app = Fastify({ logger: false });

  registerRealAppearanceRoutes(app, {
    pool,
    stagingPublicationEnabled: true,
    verifier: {
      async verifyBearerToken(token) {
        if (token !== "test-session") return null;
        return {
          identityId,
          tenantId,
          expiresAtUnixSeconds: Date.now() / 1000 + 60,
        };
      },
    },
  });

  try {
    const url = "/v1/organizations/" + tenantId + "/appearance/draft";

    const anonymous = await app.inject({ method: "GET", url });
    assert.equal(anonymous.statusCode, 401);
    assert.deepEqual(anonymous.json(), { error: "unauthorized" });
    assert.equal(anonymous.headers["cache-control"], "no-store");

    const forged = await app.inject({
      method: "GET",
      url,
      headers: { authorization: "Bearer invalid" },
    });
    assert.equal(forged.statusCode, 401);

    const foreign = await app.inject({
      method: "GET",
      url: "/v1/organizations/" + foreignId + "/appearance/draft",
      headers: { authorization: "Bearer test-session" },
    });
    assert.equal(foreign.statusCode, 403);
    assert.equal(foreign.headers["vary"], "Authorization");

    const oversizedRevision = await app.inject({
      method: "PUT",
      url,
      headers: { authorization: "Bearer test-session" },
      payload: {
        expectedRevision: Number.MAX_SAFE_INTEGER + 1,
        config: createBrandConfig("forest"),
      },
    });
    assert.equal(oversizedRevision.statusCode, 400);

    const injectedConfig = await app.inject({
      method: "PUT",
      url,
      headers: { authorization: "Bearer test-session" },
      payload: {
        expectedRevision: 0,
        config: {
          ...createBrandConfig("atelier"),
          backgroundColor: "url(javascript:alert(1))",
        },
      },
    });
    assert.equal(injectedConfig.statusCode, 400);
    assert.deepEqual(injectedConfig.json(), { error: "invalid-branding" });

    const forgedExtra = await app.inject({
      method: "POST",
      url: "/v1/organizations/" + tenantId + "/appearance/publish",
      headers: { authorization: "Bearer test-session" },
      payload: { expectedRevision: 1, tenantId: foreignId },
    });
    assert.equal(forgedExtra.statusCode, 400);

    assert.equal(
      dbConnections,
      0,
      "Request authentication and schema validation must run before DB work",
    );

    const unavailable = await app.inject({
      method: "GET",
      url,
      headers: { authorization: "Bearer test-session" },
    });
    assert.equal(unavailable.statusCode, 503);
    assert.deepEqual(unavailable.json(), { error: "unavailable" });
    assert.equal(dbConnections, 1);
  } finally {
    await app.close();
  }
});
