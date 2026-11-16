import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createApp } from "../src/app.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { linkVerifiedTelegramOwner } from "../../../packages/platform-identity/src/link-telegram-owner.js";
import { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";
import { provisionOwnerWorkspace } from "../../../packages/platform-identity/src/provision-owner-workspace.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import { createPostgresVerifiedTelegramLinkResolver } from "../../../packages/platform-identity/src/telegram-links.js";

const BOT = "123456789:synthetic_catalog_not_real_bot";
const SECRET = Buffer.alloc(32, 0x3d);

function proof(userId: number): string {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: randomUUID(),
    user: JSON.stringify({ id: userId, first_name: "Synthetic" }),
  };
  const check = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => name + "=" + value)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return Object.entries(fields)
    .map(([name, value]) => name + "=" + encodeURIComponent(value))
    .join("&") + "&hash=" + hash;
}

test(
  "real owner catalog create/list persists, deduplicates and denies revoked/foreign access",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-owner-catalog-e2e",
      max: 6,
    });
    const ownerId = randomUUID();
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
    const app = createApp(pool, {
      telegramAuthRoutes: { sessions },
      catalogRoutes: { pool, verifier: sessions },
    });
    const disabled = createApp(pool);
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query("INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)", [ownerId]);
      const owner = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: ownerId,
        organizationName: "Synthetic catalog salon",
        locationName: "Central",
        timeZone: "UTC",
        idempotencyKey: "catalog-setup-" + randomUUID(),
      });
      const signed = proof(19190001);
      await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: owner.tenantId,
        ownerIdentityId: ownerId,
        rawInitData: signed,
        consentConfirmed: true,
      });
      const prefix = "/v1/organizations/" + owner.tenantId + "/services";
      const absent = await disabled.inject({ method: "GET", url: prefix });
      assert.equal(absent.statusCode, 404);
      assert.equal((await app.inject({ method: "GET", url: prefix })).statusCode, 401);
      const exchange = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: signed },
      });
      assert.equal(exchange.statusCode, 201);
      const token: string = exchange.json().accessToken;
      const headers = { authorization: "Bearer " + token };
      const empty = await app.inject({ method: "GET", url: prefix, headers });
      assert.equal(empty.statusCode, 200);
      assert.equal(empty.headers["cache-control"], "no-store");
      assert.deepEqual(empty.json(), { services: [] });
      const foreign = await app.inject({
        method: "GET",
        url: "/v1/organizations/" + randomUUID() + "/services",
        headers,
      });
      assert.equal(foreign.statusCode, 403);
      const draft = { displayName: " Synthetic haircut ", durationMinutes: 60, basePriceKopecks: 150000 };
      const key = "catalog-post-" + randomUUID();
      const submit = () => app.inject({
        method: "POST", url: prefix,
        headers: { ...headers, "idempotency-key": key },
        payload: draft,
      });
      const [first, second] = await Promise.all([submit(), submit()]);
      assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 201]);
      const a = first.json().service;
      const b = second.json().service;
      assert.deepEqual(a, b);
      assert.equal(a.active, false);
      assert.equal(a.displayName, "Synthetic haircut");
      assert.equal(a.basePriceKopecks, 150000);
      assert.match(a.id, /^[0-9a-f-]{36}$/);
      const changed = await app.inject({
        method: "POST", url: prefix,
        headers: { ...headers, "idempotency-key": key },
        payload: { ...draft, durationMinutes: 30 },
      });
      assert.equal(changed.statusCode, 409);
      const invalid = await app.inject({
        method: "POST", url: prefix,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { ...draft, active: true },
      });
      assert.equal(invalid.statusCode, 400);
      const list = await app.inject({ method: "GET", url: prefix, headers });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(list.json().services, [a]);
      const saved = await pool.query(
        "SELECT count(*)::int AS count FROM cookie_catalog.services WHERE tenant_id=$1::uuid",
        [owner.tenantId],
      );
      assert.equal(saved.rows[0].count, 1);
      // Permission reduction denies even a still-valid authenticated bearer.
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=ARRAY[\u0027organization.context.read\u0027]::text[] WHERE tenant_id=$1::uuid",
        [owner.tenantId],
      );
      assert.equal((await app.inject({ method: "GET", url: prefix, headers })).statusCode, 403);
      assert.equal((await submit()).statusCode, 403);
      await app.inject({ method: "POST", url: "/v1/auth/logout", headers });
      assert.equal((await app.inject({ method: "GET", url: prefix, headers })).statusCode, 401);
    } finally {
      await disabled.close();
      await app.close();
      await pool.end();
    }
  },
);
