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
  return (
    Object.entries(fields)
      .map(([name, value]) => name + "=" + encodeURIComponent(value))
      .join("&") +
    "&hash=" +
    hash
  );
}


test(
  "verified Telegram owner staff draft creation is persistent, idempotent and tenant-scoped",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-owner-staff-e2e",
      max: 6,
    });
    const ownerId = randomUUID();
    const foreignOwnerId = randomUUID();
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
      staffRoutes: { pool, verifier: sessions },
    });
    const disabled = createApp(pool);
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid),($2::uuid)",
        [ownerId, foreignOwnerId],
      );
      const owner = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: ownerId,
        organizationName: "Synthetic owner studio",
        locationName: "First branch",
        timeZone: "UTC",
        idempotencyKey: "staff-owner-" + randomUUID(),
      });
      const foreign = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: foreignOwnerId,
        organizationName: "Another synthetic studio",
        locationName: "Foreign branch",
        timeZone: "UTC",
        idempotencyKey: "staff-foreign-" + randomUUID(),
      });

      const signed = proof(19190002);
      await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: owner.tenantId,
        ownerIdentityId: ownerId,
        rawInitData: signed,
        consentConfirmed: true,
      });
      const path = "/v1/organizations/" + owner.tenantId + "/staff";
      assert.equal((await disabled.inject({ method: "GET", url: path })).statusCode, 404);
      assert.equal((await app.inject({ method: "GET", url: path })).statusCode, 401);
      const exchanged = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: signed },
      });
      assert.equal(exchanged.statusCode, 201);
      const headers = { authorization: "Bearer " + exchanged.json().accessToken };
      const empty = await app.inject({ method: "GET", url: path, headers });
      assert.equal(empty.statusCode, 200);
      assert.equal(empty.headers["cache-control"], "no-store");
      assert.deepEqual(empty.json().staff, []);
      assert.deepEqual(empty.json().locations, [
        { id: owner.locationId, displayName: "First branch" },
      ]);
      assert.equal(
        (await app.inject({
          method: "GET",
          url: "/v1/organizations/" + foreign.tenantId + "/staff",
          headers,
        })).statusCode,
        403,
      );

      const service = await app.inject({
        method: "POST",
        url: "/v1/organizations/" + owner.tenantId + "/services",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          displayName: "Synthetic manicure",
          durationMinutes: 45,
          basePriceKopecks: 100000,
        },
      });
      assert.equal(service.statusCode, 201);
      const serviceId: string = service.json().service.id;
      const foreignServiceId = randomUUID();
      await pool.query(
        `INSERT INTO cookie_catalog.services
           (tenant_id,id,display_name,duration_minutes,base_price_kopecks)
         VALUES($1::uuid,$2::uuid,'Foreign service',30,50000)`,
        [foreign.tenantId, foreignServiceId],
      );

      const draft = {
        displayName: " Synthetic Ada ",
        positionTitle: " Lead stylist ",
        locationId: owner.locationId,
        serviceId,
      };
      const key = randomUUID();
      const submit = () =>
        app.inject({
          method: "POST",
          url: path,
          headers: { ...headers, "idempotency-key": key },
          payload: draft,
        });
      const [first, second] = await Promise.all([submit(), submit()]);
      assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 201]);
      const staff = first.json().staff;
      assert.deepEqual(second.json().staff, staff);
      assert.equal(staff.displayName, "Synthetic Ada");
      assert.equal(staff.positionTitle, "Lead stylist");
      assert.equal(staff.active, true);
      assert.equal(staff.bookable, false);
      assert.deepEqual(staff.assignments, [
        { locationId: owner.locationId, serviceIds: [serviceId] },
      ]);
      const persisted = await app.inject({ method: "GET", url: path, headers });
      assert.equal(persisted.statusCode, 200);
      assert.deepEqual(persisted.json().staff, [staff]);
      const stored = await pool.query(
        `SELECT
          (SELECT count(*)::int FROM cookie_staff.staff_profiles
            WHERE tenant_id=$1::uuid) AS profiles,
          (SELECT count(*)::int FROM cookie_staff.location_assignments
            WHERE tenant_id=$1::uuid AND active=false) AS locations,
          (SELECT count(*)::int FROM cookie_staff.service_assignments
            WHERE tenant_id=$1::uuid AND active=false) AS services,
          (SELECT count(*)::int FROM cookie_staff.staff_create_receipts
            WHERE tenant_id=$1::uuid) AS receipts`,
        [owner.tenantId],
      );
      assert.deepEqual(stored.rows[0], {
        profiles: 1,
        locations: 1,
        services: 1,
        receipts: 1,
      });

      const conflict = await app.inject({
        method: "POST",
        url: path,
        headers: { ...headers, "idempotency-key": key },
        payload: { ...draft, positionTitle: "Changed" },
      });
      assert.equal(conflict.statusCode, 409);
      for (const payload of [
        { ...draft, locationId: foreign.locationId },
        { ...draft, serviceId: foreignServiceId },
      ]) {
        const denied = await app.inject({
          method: "POST",
          url: path,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload,
        });
        assert.equal(denied.statusCode, 404);
      }
      for (const payload of [
        { ...draft, bookable: true },
        { ...draft, serviceId: "wrong" },
        { ...draft, positionTitle: null },
        { ...draft, displayName: "" },
      ]) {
        const invalid = await app.inject({
          method: "POST",
          url: path,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload,
        });
        assert.equal(invalid.statusCode, 400);
      }

      await pool.query(
        `UPDATE cookie_identity.roles
          SET permissions=ARRAY['organization.context.read','catalog.service.read']::text[]
          WHERE tenant_id=$1::uuid`,
        [owner.tenantId],
      );
      assert.equal(
        (await app.inject({ method: "GET", url: path, headers })).statusCode,
        403,
      );
      assert.equal((await submit()).statusCode, 403);
      await app.inject({ method: "POST", url: "/v1/auth/logout", headers });
      assert.equal(
        (await app.inject({ method: "GET", url: path, headers })).statusCode,
        401,
      );
    } finally {
      await disabled.close();
      await app.close();
      await pool.end();
    }
  },
);
