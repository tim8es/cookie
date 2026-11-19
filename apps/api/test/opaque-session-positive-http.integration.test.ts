import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createApp } from "../src/app.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import { createPostgresVerifiedTelegramLinkResolver } from "../../../packages/platform-identity/src/telegram-links.js";

const BOT = "123456789:synthetic_key_NOT_A_REAL_BOT_TOKEN_2026";
const USER = "279058397";
const SECRET = Buffer.alloc(32, 0x5e);

function signedInitData(): string {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1_000)),
    query_id: randomUUID(),
    user: JSON.stringify({ id: Number(USER), first_name: "Synthetic" }),
  };
  const payload = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + "=" + value)
    .join("\n");
  const key = createHmac("sha256", "WebAppData").update(BOT).digest();
  const hash = createHmac("sha256", key).update(payload).digest("hex");
  return (
    Object.entries(fields)
      .map(([name, value]) => name + "=" + encodeURIComponent(value))
      .join("&") +
    "&hash=" +
    hash
  );
}

test(
  "valid Cookie bearer completes Booking, idempotent replay and post-revocation denial",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-session-booking-revoke-race",
      max: 5,
      connectionTimeoutMillis: 5_000,
    });
    const tenantId = randomUUID();
    const identityId = randomUUID();
    const linkId = randomUUID();
    const roleId = randomUUID();
    const assignmentId = randomUUID();
    const locationId = randomUUID();
    const staffId = randomUUID();
    const serviceId = randomUUID();
    const customerId = randomUUID();
    const apps: Array<ReturnType<typeof createApp>> = [];

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1)",
        [identityId],
      );
      await pool.query(
        "INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name) VALUES($1,$2,'Synthetic session revocation tenant')",
        [tenantId, identityId],
      );
      await pool.query(
        "INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone) VALUES($1,$2,'QA location','UTC')",
        [tenantId, locationId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.memberships(tenant_id,identity_id) VALUES($1,$2)",
        [tenantId, identityId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name,permissions) VALUES($1,$2,'owner','Owner',ARRAY['booking.create'])",
        [tenantId, roleId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.role_assignments(tenant_id,id,identity_id,role_id) VALUES($1,$2,$3,$4)",
        [tenantId, assignmentId, identityId, roleId],
      );
      await pool.query(
        "INSERT INTO cookie_customers.customers(tenant_id,id) VALUES($1,$2)",
        [tenantId, customerId],
      );
      await pool.query(
        "INSERT INTO cookie_catalog.services(tenant_id,id,display_name,duration_minutes,post_service_buffer_minutes,base_price_kopecks,active) VALUES($1,$2,'Synthetic service',60,10,100000,true)",
        [tenantId, serviceId],
      );
      await pool.query(
        "INSERT INTO cookie_staff.staff_profiles(tenant_id,id,display_name,active,bookable) VALUES($1,$2,'Synthetic staff',true,true)",
        [tenantId, staffId],
      );
      await pool.query(
        "INSERT INTO cookie_staff.location_assignments(tenant_id,staff_id,location_id,active) VALUES($1,$2,$3,true)",
        [tenantId, staffId, locationId],
      );
      await pool.query(
        "INSERT INTO cookie_staff.service_assignments(tenant_id,staff_id,location_id,service_id,active) VALUES($1,$2,$3,$4,true)",
        [tenantId, staffId, locationId, serviceId],
      );
      await pool.query(
        "INSERT INTO cookie_scheduling.shift_windows(tenant_id,id,staff_id,location_id,start_at,end_at,active) VALUES($1,$2,$3,$4,'2028-12-14T09:00:00Z','2028-12-14T19:00:00Z',true)",
        [tenantId, randomUUID(), staffId, locationId],
      );

      const fingerprint = createHmac("sha256", SECRET)
        .update("cookie-telegram-user-fingerprint-v1\0")
        .update(USER)
        .digest();
      await pool.query(
        "INSERT INTO cookie_identity.telegram_identity_links(tenant_id,id,identity_id,telegram_user_hmac_sha256,proof_verified_at,consent_confirmed_at) VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp())",
        [tenantId, linkId, identityId, fingerprint],
      );

      const sessions = new PostgresOpaqueTelegramSessions({
        pool,
        fingerprintSecret: SECRET,
        telegramProofVerifier: createTelegramMiniAppProofVerifier({
          botToken: BOT,
          maxAgeSeconds: 600,
        }),
        resolveVerifiedTelegramLink: createPostgresVerifiedTelegramLinkResolver(
          {
            userHashSecret: SECRET,
          },
        ),
        issuer: "cookie-qa",
        audience: "booking-qa",
        ttlSeconds: 600,
      });
      const issued = await sessions.exchangeTelegramInitData(signedInitData());
      assert.ok(issued, "trusted Telegram proof must issue a live session");
      const app = createApp(pool, {
        syntheticBookingRoutes: {
          pool,
          verifier: sessions,
          assertEntitled: async () => undefined,
        },
      });
      apps.push(app);
      const command = {
        method: "POST" as const,
        url: "/v1/organizations/" + tenantId + "/bookings",
        headers: {
          authorization: "Bearer " + issued.bearerToken,
          "idempotency-key": "qa-valid-cookie-booking",
        },
        payload: {
          customerId,
          locationId,
          staffId,
          serviceId,
          startAt: "2028-12-14T10:00:00Z",
        },
      };

      const first = await app.inject(command);
      assert.equal(first.statusCode, 201, "valid session must create Booking");
      assert.equal(first.json().status, "Confirmed");
      assert.ok(first.json().bookingId);

      const replay = await app.inject(command);
      assert.equal(replay.statusCode, 201, "idempotent replay must succeed");
      assert.deepEqual(replay.json(), first.json());

      async function counts() {
        const result = await pool.query<{
          bookings: number;
          receipts: number;
          events: number;
        }>(
          "SELECT (SELECT count(*)::int FROM cookie_booking.bookings WHERE tenant_id=$1) AS bookings, (SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1) AS receipts, (SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1) AS events",
          [tenantId],
        );
        return result.rows[0];
      }
      assert.deepEqual(await counts(), {
        bookings: 1,
        receipts: 1,
        events: 1,
      });

      assert.equal(await sessions.revokeBearerToken(issued.bearerToken), true);
      assert.equal(await sessions.verifyBearerToken(issued.bearerToken), null);
      const denied = await app.inject(command);
      assert.ok(
        denied.statusCode === 401 || denied.statusCode === 403,
        "replayed committed idempotency receipt must not bypass revoked AuthN",
      );
      assert.deepEqual(await counts(), {
        bookings: 1,
        receipts: 1,
        events: 1,
      });
    } finally {
      for (const app of apps) await app.close().catch(() => undefined);
      const tables = [
        "cookie_booking.command_receipts",
        "cookie_jobs.outbox_events",
        "cookie_booking.bookings",
        "cookie_identity.authorization_audit",
        "cookie_scheduling.shift_windows",
        "cookie_staff.service_assignments",
        "cookie_staff.location_assignments",
        "cookie_staff.staff_profiles",
        "cookie_catalog.services",
        "cookie_customers.customers",
        "cookie_identity.opaque_sessions",
        "cookie_identity.telegram_identity_links",
        "cookie_identity.role_assignments",
        "cookie_identity.roles",
        "cookie_identity.memberships",
        "cookie_tenancy.locations",
      ];
      try {
        for (const table of tables) {
          await pool
            .query("DELETE FROM " + table + " WHERE tenant_id=$1", [tenantId])
            .catch(() => undefined);
        }
        await pool
          .query("DELETE FROM cookie_tenancy.organizations WHERE id=$1", [
            tenantId,
          ])
          .catch(() => undefined);
        await pool
          .query("DELETE FROM cookie_identity.identities WHERE id=$1", [
            identityId,
          ])
          .catch(() => undefined);
      } finally {
        await pool.end();
      }
    }
  },
);
