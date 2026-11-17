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

const BOT = "123456789:synthetic_staff_not_a_real_bot";
const SECRET = Buffer.alloc(32, 0x65);

function proof(userId: number): string {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: randomUUID(),
    user: JSON.stringify({ id: userId, first_name: "Synthetic" }),
  };
  const check = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return (
    Object.entries(fields)
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join("&") +
    "&hash=" +
    hash
  );
}

test(
  "real owner staff create/list uses PostgreSQL, exact replay and current authorization",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-real-staff-qa",
      max: 6,
    });
    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
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
      staffRoutes: { pool, verifier: sessions },
    });
    const disabled = createApp(pool);
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid),($2::uuid)",
        [ownerId, otherOwnerId],
      );
      const owner = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: ownerId,
        organizationName: "Synthetic team salon",
        locationName: "Main branch",
        timeZone: "Europe/Moscow",
        idempotencyKey: "staff-owner-" + randomUUID(),
      });
      const foreign = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: otherOwnerId,
        organizationName: "Foreign team salon",
        locationName: "Other branch",
        timeZone: "UTC",
        idempotencyKey: "staff-foreign-" + randomUUID(),
      });
      const signed = proof(20100501);
      await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: owner.tenantId,
        ownerIdentityId: ownerId,
        rawInitData: signed,
        consentConfirmed: true,
      });
      const url = `/v1/organizations/${owner.tenantId}/staff`;
      assert.equal((await disabled.inject({ method: "GET", url })).statusCode, 404);
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);

      const exchange = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: signed },
      });
      assert.equal(exchange.statusCode, 201);
      const bearer = exchange.json().accessToken as string;
      const headers = { authorization: `Bearer ${bearer}` };

      const empty = await app.inject({ method: "GET", url, headers });
      assert.equal(empty.statusCode, 200);
      assert.deepEqual(empty.json(), { staff: [] });
      assert.equal(empty.headers["cache-control"], "no-store");

      const foreignRead = await app.inject({
        method: "GET",
        url: `/v1/organizations/${foreign.tenantId}/staff`,
        headers,
      });
      assert.equal(foreignRead.statusCode, 403);
      assert.doesNotMatch(foreignRead.body, /Foreign team salon/);

      const draft = { displayName: " Алекс Тест ", positionTitle: " Мастер " };
      const key = "staff-profile-" + randomUUID();
      const create = () =>
        app.inject({
          method: "POST",
          url,
          headers: { ...headers, "idempotency-key": key },
          payload: draft,
        });
      const [first, replay] = await Promise.all([create(), create()]);
      assert.deepEqual([first.statusCode, replay.statusCode].sort(), [200, 201]);
      const saved = first.json().staff;
      assert.deepEqual(saved, replay.json().staff);
      assert.equal(saved.displayName, "Алекс Тест");
      assert.equal(saved.positionTitle, "Мастер");
      assert.equal(saved.active, true);
      assert.equal(saved.bookable, false);
      assert.match(saved.id, /^[0-9a-f-]{36}$/);

      const changed = await app.inject({
        method: "POST",
        url,
        headers: { ...headers, "idempotency-key": key },
        payload: { ...draft, positionTitle: "Администратор" },
      });
      assert.equal(changed.statusCode, 409);
      const unsafe = await app.inject({
        method: "POST",
        url,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { ...draft, bookable: true },
      });
      assert.equal(unsafe.statusCode, 400);
      const injectedIdentity = await app.inject({
        method: "POST",
        url,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { ...draft, identityId: otherOwnerId },
      });
      assert.equal(injectedIdentity.statusCode, 400);

      const listed = await app.inject({ method: "GET", url, headers });
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(listed.json(), { staff: [saved] });
      const db = await pool.query<{
        total: number;
        bookable: boolean;
        active_assignments: number;
        identity_roles: number;
      }>(
        `SELECT
            (SELECT count(*)::int FROM cookie_staff.staff_profiles
             WHERE tenant_id=$1::uuid) AS total,
            (SELECT bookable FROM cookie_staff.staff_profiles
             WHERE tenant_id=$1::uuid AND id=$2::uuid) AS bookable,
            (SELECT count(*)::int FROM cookie_staff.location_assignments
             WHERE tenant_id=$1::uuid) AS active_assignments,
            (SELECT count(*)::int FROM cookie_identity.role_assignments
             WHERE tenant_id=$1::uuid) AS identity_roles`,
        [owner.tenantId, saved.id],
      );
      assert.deepEqual(db.rows[0], {
        total: 1,
        bookable: false,
        active_assignments: 0,
        identity_roles: 1,
      });

      // A still-valid Cookie bearer loses staff permission immediately.
      await pool.query(
        `UPDATE cookie_identity.roles
           SET permissions=ARRAY['organization.context.read']::text[]
         WHERE tenant_id=$1::uuid AND base_type='owner'`,
        [owner.tenantId],
      );
      assert.equal((await app.inject({ method: "GET", url, headers })).statusCode, 403);
      assert.equal((await create()).statusCode, 403);

      const logout = await app.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers,
      });
      assert.equal(logout.statusCode, 204);
      assert.equal((await app.inject({ method: "GET", url, headers })).statusCode, 401);
    } finally {
      await disabled.close();
      await app.close();
      await pool.end();
    }
  },
);
