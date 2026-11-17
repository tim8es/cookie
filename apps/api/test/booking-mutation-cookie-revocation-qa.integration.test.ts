import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createBookingInternal } from "../../../packages/domain-booking/src/create.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import { createApp } from "../src/app.js";
import type { BearerSessionVerifier } from "../src/session-context.js";

test(
  "cancel and reschedule reject revoked or expired exact Cookie bearer after successful HTTP preflight",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-mutation-cookie-preflight-revoke",
      max: 8,
      connectionTimeoutMillis: 5_000,
    });
    const tenantId = randomUUID();
    const identityId = randomUUID();
    const roleId = randomUUID();
    const locationId = randomUUID();
    const staffId = randomUUID();
    const serviceId = randomUUID();
    const customerId = randomUUID();
    const apps: Array<ReturnType<typeof createApp>> = [];
    const actor = {
      tenantId,
      identityId,
      correlationId: "qa-mutation-cookie-revoke-setup",
    };

    const sessions = new PostgresOpaqueTelegramSessions({
      pool,
      telegramProofVerifier: createTelegramMiniAppProofVerifier({
        botToken: "123456789:synthetic_key_NOT_A_REAL_BOT_TOKEN_2026",
        maxAgeSeconds: 600,
      }),
      resolveVerifiedTelegramLink: async () => null,
      issuer: "cookie-qa",
      audience: "booking-qa",
      ttlSeconds: 600,
    });
    const url = (id: string, operation: "cancel" | "reschedule") =>
      "/v1/organizations/" + tenantId + "/bookings/" + id + "/" + operation;
    const makeApp = (verifier: BearerSessionVerifier) =>
      createApp(pool, {
        syntheticBookingMutations: {
          pool,
          verifier,
          assertMayCancel: async () => undefined,
          assertMayReschedule: async () => undefined,
        },
      });
    const sessionToken = async (): Promise<string> => {
      const token = "cs_" + randomBytes(32).toString("base64url");
      await pool.query(
        `INSERT INTO cookie_identity.opaque_sessions
           (token_sha256,telegram_exchange_sha256,tenant_id,identity_id,
            issuer,audience,expires_at)
         VALUES($1::bytea,$2::bytea,$3::uuid,$4::uuid,'cookie-qa',
                'booking-qa',clock_timestamp()+interval '10 minutes')`,
        [
          createHash("sha256").update(token).digest(),
          randomBytes(32),
          tenantId,
          identityId,
        ],
      );
      assert.ok(await sessions.verifyBearerToken(token));
      return token;
    };
    const snapshot = async (): Promise<Record<string, number>> => {
      const result = await pool.query<Record<string, number>>(
        `SELECT
           (SELECT count(*)::int FROM cookie_booking.bookings WHERE tenant_id=$1::uuid) AS bookings,
           (SELECT count(*)::int FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND status='Confirmed') AS confirmed,
           (SELECT count(*)::int FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND status='CancelledByBusiness') AS cancelled,
           (SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1::uuid) AS receipts,
           (SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid) AS events,
           (SELECT count(*)::int FROM cookie_booking.time_change_audit WHERE tenant_id=$1::uuid) AS moves,
           (SELECT count(*)::int FROM cookie_booking.booking_state_audit WHERE tenant_id=$1::uuid) AS cancels`,
        [tenantId],
      );
      assert.ok(result.rows[0]);
      return result.rows[0];
    };

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [identityId],
      );
      await pool.query(
        "INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name) VALUES($1::uuid,$2::uuid,'QA mutation token revocation')",
        [tenantId, identityId],
      );
      await pool.query(
        "INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone) VALUES($1::uuid,$2::uuid,'QA branch','UTC')",
        [tenantId, locationId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.memberships(tenant_id,identity_id) VALUES($1::uuid,$2::uuid)",
        [tenantId, identityId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name,permissions) VALUES($1::uuid,$2::uuid,'owner','QA Owner',ARRAY['booking.create','booking.cancel','booking.reschedule'])",
        [tenantId, roleId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.role_assignments(tenant_id,id,identity_id,role_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)",
        [tenantId, randomUUID(), identityId, roleId],
      );
      await pool.query(
        "INSERT INTO cookie_customers.customers(tenant_id,id) VALUES($1::uuid,$2::uuid)",
        [tenantId, customerId],
      );
      await pool.query(
        "INSERT INTO cookie_catalog.services(tenant_id,id,display_name,duration_minutes,post_service_buffer_minutes,base_price_kopecks,active) VALUES($1::uuid,$2::uuid,'QA service',60,10,125000,true)",
        [tenantId, serviceId],
      );
      await pool.query(
        "INSERT INTO cookie_staff.staff_profiles(tenant_id,id,display_name,active,bookable) VALUES($1::uuid,$2::uuid,'QA master',true,true)",
        [tenantId, staffId],
      );
      await pool.query(
        "INSERT INTO cookie_staff.location_assignments(tenant_id,staff_id,location_id,active) VALUES($1::uuid,$2::uuid,$3::uuid,true)",
        [tenantId, staffId, locationId],
      );
      await pool.query(
        "INSERT INTO cookie_staff.service_assignments(tenant_id,staff_id,location_id,service_id,active) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,true)",
        [tenantId, staffId, locationId, serviceId],
      );
      await pool.query(
        `INSERT INTO cookie_scheduling.shift_windows
           (tenant_id,id,staff_id,location_id,start_at,end_at,active)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,
                '2028-09-20T09:00:00Z','2028-09-20T21:00:00Z',true)`,
        [tenantId, randomUUID(), staffId, locationId],
      );

      const bookings = [];
      for (const hour of ["10", "12", "14", "16"]) {
        const created = await createBookingInternal(
          pool,
          {
            actor,
            customerId,
            locationId,
            staffId,
            serviceId,
            startAt: "2028-09-20T" + hour + ":00:00Z",
            idempotencyKey: "qa-fixture-create-" + hour,
          },
          async () => undefined,
        );
        assert.equal(created.status, "Confirmed");
        bookings.push(created.bookingId);
      }
      const [
        reschedulePositiveId,
        cancelPositiveId,
        cancelBlockedId,
        rescheduleBlockedId,
      ] = bookings as [string, string, string, string];

      const control = makeApp(sessions);
      apps.push(control);
      const controlToken = await sessionToken();
      const positiveHeaders = {
        authorization: "Bearer " + controlToken,
        "idempotency-key": "qa-control-cancel",
      };
      const cancelled = await control.inject({
        method: "POST",
        url: url(cancelPositiveId, "cancel"),
        headers: positiveHeaders,
        payload: {},
      });
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      assert.equal(cancelled.json().status, "CancelledByBusiness");
      const moved = await control.inject({
        method: "POST",
        url: url(reschedulePositiveId, "reschedule"),
        headers: {
          authorization: "Bearer " + controlToken,
          "idempotency-key": "qa-control-reschedule",
        },
        payload: { newStartAt: "2028-09-20T18:00:00Z" },
      });
      assert.equal(moved.statusCode, 200, moved.body);
      assert.equal(moved.json().status, "Confirmed");

      for (const [kind, bookingId, operation] of [
        ["bearer-revoked", cancelBlockedId, "cancel"],
        ["session-expired", rescheduleBlockedId, "reschedule"],
      ] as const) {
        const token = await sessionToken();
        let reached!: () => void;
        const verified = new Promise<void>((done) => {
          reached = done;
        });
        let release!: () => void;
        const released = new Promise<void>((done) => {
          release = done;
        });
        const verifier = {
          async verifyBearerToken(value: string) {
            const authority = await sessions.verifyBearerToken(value);
            if (authority) {
              reached();
              await released;
            }
            return authority;
          },
        };
        const app = makeApp(verifier);
        apps.push(app);
        const before = await snapshot();
        const target = await pool.query<{ status: string; start_at: Date }>(
          "SELECT status,start_at FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
          [tenantId, bookingId],
        );
        assert.ok(target.rows[0]);
        const pending = app.inject({
          method: "POST",
          url: url(bookingId, operation),
          headers: {
            authorization: "Bearer " + token,
            "idempotency-key": "qa-blocked-" + kind,
          },
          payload:
            operation === "cancel"
              ? {}
              : { newStartAt: "2028-09-20T19:30:00Z" },
        });
        try {
          assert.equal(
            await Promise.race([
              verified.then(() => true),
              pending.then(() => false),
            ]),
            true,
            "valid exact Cookie token must complete real HTTP AuthN before revocation",
          );
          if (kind === "bearer-revoked") {
            assert.equal(await sessions.revokeBearerToken(token), true);
          } else {
            const expired = await pool.query(
              `UPDATE cookie_identity.opaque_sessions
                  SET issued_at=clock_timestamp()-interval '610 seconds',
                      expires_at=clock_timestamp()-interval '1 second'
                WHERE tenant_id=$1::uuid AND token_sha256=$2::bytea
                  AND revoked_at IS NULL RETURNING token_sha256`,
              [tenantId, createHash("sha256").update(token).digest()],
            );
            assert.equal(expired.rowCount, 1);
          }
          assert.equal(
            await sessions.verifyBearerToken(token),
            null,
            "Cookie authority is lost and committed before the HTTP mutation starts",
          );
        } finally {
          release();
        }
        const result = await pending;
        assert.equal(
          result.statusCode,
          403,
          kind + ": revoked preflight must deny",
        );
        assert.deepEqual(
          await snapshot(),
          before,
          kind + ": no new receipts or outbox",
        );
        const after = await pool.query<{ status: string; start_at: Date }>(
          "SELECT status,start_at FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
          [tenantId, bookingId],
        );
        assert.equal(after.rows[0]?.status, target.rows[0].status);
        assert.deepEqual(after.rows[0]?.start_at, target.rows[0].start_at);
        await app.close();
      }

      // Complement revoke-first tests: the exact Cookie session must remain
      // locked through each mutation's commit, not merely through preflight.
      for (const operation of ["create", "cancel", "reschedule"] as const) {
        await t.test(operation + " serializes bearer revoke", async () => {
          const token = await sessionToken();
          let reached!: () => void;
          const checkpoint = new Promise<void>((done) => {
            reached = done;
          });
          let release!: () => void;
          const resume = new Promise<void>((done) => {
            release = done;
          });
          const hold = async () => {
            reached();
            await resume;
          };
          const app = createApp(pool, {
            syntheticBookingRoutes: {
              pool,
              verifier: sessions,
              assertEntitled: hold,
            },
            syntheticBookingMutations: {
              pool,
              verifier: sessions,
              assertMayCancel: hold,
              assertMayReschedule: hold,
            },
          });
          apps.push(app);
          const request = {
            method: "POST" as const,
            url:
              operation === "create"
                ? "/v1/organizations/" + tenantId + "/bookings"
                : url(
                    operation === "cancel"
                      ? cancelBlockedId
                      : rescheduleBlockedId,
                    operation,
                  ),
            headers: {
              authorization: "Bearer " + token,
              "idempotency-key": "qa-command-first-" + operation,
            },
            payload:
              operation === "create"
                ? {
                    customerId,
                    locationId,
                    staffId,
                    serviceId,
                    startAt: "2028-09-20T19:30:00Z",
                  }
                : operation === "cancel"
                  ? {}
                  : { newStartAt: "2028-09-20T12:00:00Z" },
          };
          const before = await snapshot();
          const revoker = await pool.connect();
          const pending = app.inject(request).then((response) => response);
          try {
            assert.equal(
              await Promise.race([
                checkpoint.then(() => true),
                pending.then(() => false),
              ]),
              true,
              "mutation must reach the policy callback after AuthN/AuthZ",
            );
            await revoker.query("BEGIN");
            await revoker.query("SET LOCAL lock_timeout='500ms'");
            try {
              await assert.rejects(
                revoker.query(
                  `UPDATE cookie_identity.opaque_sessions
                      SET revoked_at=clock_timestamp()
                    WHERE tenant_id=$1::uuid AND token_sha256=$2::bytea
                      AND revoked_at IS NULL`,
                  [tenantId, createHash("sha256").update(token).digest()],
                ),
                { code: "55P03" },
                "exact bearer revocation must wait for Booking COMMIT",
              );
            } finally {
              await revoker.query("ROLLBACK");
            }
          } finally {
            revoker.release();
            release();
            await pending;
          }
          const response = await pending;
          assert.equal(
            response.statusCode,
            operation === "create" ? 201 : 200,
            response.body,
          );
          assert.equal(
            response.json().status,
            operation === "cancel" ? "CancelledByBusiness" : "Confirmed",
          );
          const after = await snapshot();
          assert.equal(after.receipts, before.receipts! + 1);
          assert.equal(after.events, before.events! + 1);
          assert.equal(
            after.bookings,
            before.bookings! + (operation === "create" ? 1 : 0),
          );
          assert.equal(await sessions.revokeBearerToken(token), true);
          assert.equal(await sessions.verifyBearerToken(token), null);
          const replay = await app.inject(request);
          assert.equal(replay.statusCode, 401);
          assert.deepEqual(await snapshot(), after);
          await app.close();
        });
      }
    } finally {
      for (const app of apps) await app.close().catch(() => undefined);
      try {
        for (const table of [
          "cookie_booking.time_change_audit",
          "cookie_booking.booking_state_audit",
          "cookie_booking.command_receipts",
          "cookie_jobs.outbox_replay_audit",
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
          "cookie_identity.role_assignments",
          "cookie_identity.roles",
          "cookie_identity.memberships",
          "cookie_tenancy.locations",
        ]) {
          await pool
            .query("DELETE FROM " + table + " WHERE tenant_id=$1::uuid", [
              tenantId,
            ])
            .catch(() => undefined);
        }
        await pool
          .query("DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid", [
            tenantId,
          ])
          .catch(() => undefined);
        await pool
          .query("DELETE FROM cookie_identity.identities WHERE id=$1::uuid", [
            identityId,
          ])
          .catch(() => undefined);
      } finally {
        await pool.end();
      }
    }
  },
);
