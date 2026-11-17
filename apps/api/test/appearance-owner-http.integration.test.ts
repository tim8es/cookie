import assert from "node:assert/strict";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createBrandConfig } from "../../../packages/domain-appearance/src/index.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { linkVerifiedTelegramOwner } from "../../../packages/platform-identity/src/link-telegram-owner.js";
import {
  createPostgresVerifiedTelegramLinkResolver,
  createTelegramMiniAppProofVerifier,
  PostgresOpaqueTelegramSessions,
} from "../../../packages/platform-identity/src/index.js";
import { provisionOwnerWorkspace } from "../../../packages/platform-identity/src/provision-owner-workspace.js";
import { createApp } from "../src/app.js";
import { registerRealAppearanceRoutes } from "../src/appearance-http.js";

const BOT = "123456789:synthetic_appearance_not_real_bot";
const SECRET = Buffer.alloc(32, 0x4b);

function signedProof(): string {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: randomUUID(),
    user: JSON.stringify({
      id: randomInt(1_000_000_000, 2_000_000_000),
      first_name: "Synthetic",
    }),
  };
  const check = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => name + "=" + value)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return (
    Object.entries(fields)
      .map(([name, value]) => name + "=" + encodeURIComponent(value))
      .join("&") +
    "&hash=" +
    hash
  );
}

test(
  "fresh PostgreSQL owner can save and publish Appearance through verified auth",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-appearance-http-e2e",
      max: 6,
    });
    const verifier = createTelegramMiniAppProofVerifier({
      botToken: BOT,
      maxAgeSeconds: 300,
    });
    const sessions = new PostgresOpaqueTelegramSessions({
      pool,
      telegramProofVerifier: verifier,
      resolveVerifiedTelegramLink: createPostgresVerifiedTelegramLinkResolver({
        userHashSecret: SECRET,
      }),
      issuer: "cookie-telegram",
      audience: "cookie-web",
      ttlSeconds: 900,
    });
    const app = createApp(pool, { telegramAuthRoutes: { sessions } });
    registerRealAppearanceRoutes(app, { pool, verifier: sessions });
    const disabled = createApp(pool);
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const ownerId = randomUUID();
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [ownerId],
      );
      const owner = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: ownerId,
        organizationName: "Synthetic appearance salon",
        locationName: "Central",
        timeZone: "UTC",
        idempotencyKey: "appearance-setup-" + randomUUID(),
      });
      const proof = signedProof();
      await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: owner.tenantId,
        ownerIdentityId: ownerId,
        rawInitData: proof,
        consentConfirmed: true,
      });
      const prefix = "/v1/organizations/" + owner.tenantId + "/appearance";
      const url = prefix + "/draft";
      assert.equal(
        (await disabled.inject({ method: "GET", url })).statusCode,
        404,
      );
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
      const exchange = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: proof },
      });
      assert.equal(exchange.statusCode, 201);
      const token: string = exchange.json().accessToken;
      const headers = { authorization: "Bearer " + token };
      const read = () => app.inject({ method: "GET", url, headers });
      const initial = await read();
      assert.equal(initial.statusCode, 200);
      assert.equal(initial.json().draft.revision, 0);
      const config = createBrandConfig("forest");
      const saved = await app.inject({
        method: "PUT",
        url,
        headers,
        payload: { expectedRevision: 0, config },
      });
      assert.equal(saved.statusCode, 200);
      assert.deepEqual(saved.json(), { draft: { revision: 1, config } });
      const publish = () =>
        app.inject({
          method: "POST",
          url: prefix + "/publish",
          headers,
          payload: { expectedRevision: 1 },
        });
      const published = await publish();
      assert.equal(published.statusCode, 200);
      assert.equal(published.json().published.revision, 1);
      assert.equal(published.headers["cache-control"], "no-store");
      const foreign = await app.inject({
        method: "GET",
        url: "/v1/organizations/" + randomUUID() + "/appearance/draft",
        headers,
      });
      assert.equal(foreign.statusCode, 403);
      await pool.query(
        `UPDATE cookie_identity.roles
            SET permissions=array_remove(permissions, 'appearance.publish')
          WHERE tenant_id=$1::uuid`,
        [owner.tenantId],
      );
      assert.equal((await publish()).statusCode, 403);
      assert.equal((await read()).statusCode, 200);
      await app.inject({ method: "POST", url: "/v1/auth/logout", headers });
      assert.equal((await read()).statusCode, 401);
    } finally {
      await disabled.close();
      await app.close();
      await pool.end();
    }
  },
);
