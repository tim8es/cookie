import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Pool } from "pg";

import { createApp } from "../src/app.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { linkVerifiedTelegramOwner } from "../../../packages/platform-identity/src/link-telegram-owner.js";
import { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";
import { provisionOwnerWorkspace } from "../../../packages/platform-identity/src/provision-owner-workspace.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import { createPostgresVerifiedTelegramLinkResolver } from "../../../packages/platform-identity/src/telegram-links.js";

const BOT = "123456789:synthetic_catalog_not_real_bot";
// A disposable test-specific HMAC namespace avoids collisions with merged suites.
const SECRET = randomBytes(32);

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
  "owner calendar mutations serialize cancellation and reschedule and deny in-flight revoked authority",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const applicationName = "cookie-owner-calendar-mutation-races";
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: applicationName,
      max: 8,
    });
    const ownerId = randomUUID();
    const verifier = createTelegramMiniAppProofVerifier({
      botToken: BOT,
      maxAgeSeconds: 300,
    });
    const sessions = new PostgresOpaqueTelegramSessions({
      pool,
      fingerprintSecret: SECRET,
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
      stagingOwnerCalendarReschedule: {
        pool,
        verifier: sessions,
        enabled: true,
        cutoffMinutes: 0,
      },
      stagingOwnerCalendarCancellation: {
        pool,
        verifier: sessions,
        enabled: true,
        cutoffMinutes: 0,
      },
    });
    let tenantId: string | undefined;
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [ownerId],
      );
      const owner = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: ownerId,
        organizationName: "Synthetic mutation race studio",
        locationName: "Synthetic branch",
        timeZone: "Europe/Moscow",
        idempotencyKey: randomUUID(),
      });
      const tenant = owner.tenantId;
      tenantId = tenant;
      const signed = proof(19190079);
      await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: tenant,
        ownerIdentityId: ownerId,
        rawInitData: signed,
        consentConfirmed: true,
      });
      const exchange = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: signed },
      });
      assert.equal(exchange.statusCode, 201, exchange.body);
      const bearer: string = exchange.json().accessToken;
      const headers = { authorization: "Bearer " + bearer };
      const prefix = "/v1/organizations/" + tenant;
      const service = await app.inject({
        method: "POST",
        url: prefix + "/services",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          displayName: "Synthetic service",
          durationMinutes: 60,
          basePriceKopecks: 100000,
        },
      });
      assert.equal(service.statusCode, 201, service.body);
      const serviceId: string = service.json().service.id;
      const staff = await app.inject({
        method: "POST",
        url: prefix + "/staff",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          displayName: "Synthetic race staff",
          positionTitle: "Stylist",
          locationId: owner.locationId,
          serviceId,
        },
      });
      assert.equal(staff.statusCode, 201, staff.body);
      const staffId: string = staff.json().staff.id;
      const customerId = randomUUID();
      await pool.query(
        "INSERT INTO cookie_customers.customers(tenant_id,id) VALUES($1::uuid,$2::uuid)",
        [tenant, customerId],
      );
      const dateAt = (offset: number) =>
        new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
      const seed = async (offset: number) => {
        const date = dateAt(offset);
        const id = randomUUID();
        const original = date + "T07:00:00.000Z";
        const target = date + "T10:00:00.000Z";
        await pool.query(
          `INSERT INTO cookie_scheduling.shift_windows
             (tenant_id,id,staff_id,location_id,start_at,end_at,active)
           VALUES($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,true)`,
          [
            tenant,
            randomUUID(),
            staffId,
            owner.locationId,
            date + "T06:00:00Z",
            date + "T15:00:00Z",
          ],
        );
        await pool.query(
          `INSERT INTO cookie_booking.bookings
             (tenant_id,id,customer_id,staff_id,location_id,service_id,status,
              start_at,end_at,occupied_until,service_duration_minutes_snapshot,
              post_service_buffer_minutes_snapshot,price_kopecks_snapshot)
           VALUES($1,$2,$3,$4,$5,$6,'Confirmed',$7::timestamptz,
             $7::timestamptz+interval '60 minutes',
             $7::timestamptz+interval '70 minutes',60,10,123456)`,
          [
            tenant,
            id,
            customerId,
            staffId,
            owner.locationId,
            serviceId,
            original,
          ],
        );
        return { id, original, target };
      };
      type Fixture = Awaited<ReturnType<typeof seed>>;
      const command = (
        row: Fixture,
        kind: "cancel" | "reschedule",
        key: string,
      ) =>
        app.inject({
          method: "POST",
          url:
            prefix +
            "/owner-calendar/" +
            row.id +
            "/" +
            kind +
            "?locationId=" +
            owner.locationId,
          headers: { ...headers, "idempotency-key": key },
          payload: kind === "cancel" ? {} : { newStartAt: row.target },
        });
      const state = (row: Fixture) =>
        pool.query(
          `SELECT status,start_at,end_at,occupied_until,
                  customer_id::text AS customer,staff_id::text AS staff,
                  service_id::text AS service,location_id::text AS location,
                  price_kopecks_snapshot::text AS price
             FROM cookie_booking.bookings WHERE tenant_id=$1 AND id=$2`,
          [tenant, row.id],
        );
      const effects = (row: Fixture) =>
        pool.query(
          `SELECT
             (SELECT count(*)::int FROM cookie_booking.time_change_audit
               WHERE tenant_id=$1 AND booking_id=$2) AS moves,
             (SELECT count(*)::int FROM cookie_booking.booking_state_audit
               WHERE tenant_id=$1 AND booking_id=$2) AS cancels,
             (SELECT count(*)::int FROM cookie_booking.command_receipts
               WHERE tenant_id=$1 AND booking_id=$2
                 AND operation='booking.reschedule') AS move_receipts,
             (SELECT count(*)::int FROM cookie_booking.command_receipts
               WHERE tenant_id=$1 AND booking_id=$2
                 AND operation='booking.cancel') AS cancel_receipts,
             (SELECT count(*)::int FROM cookie_jobs.outbox_events
               WHERE tenant_id=$1 AND topic='booking.rescheduled'
                 AND payload->>'bookingId'=($2::uuid)::text) AS move_events,
             (SELECT count(*)::int FROM cookie_jobs.outbox_events
               WHERE tenant_id=$1 AND topic='booking.cancelled'
                 AND payload->>'bookingId'=($2::uuid)::text) AS cancel_events`,
          [tenant, row.id],
        );
      const expectedEffects = (moves: number, cancels: number) => ({
        moves,
        cancels,
        move_receipts: moves,
        cancel_receipts: cancels,
        move_events: moves,
        cancel_events: cancels,
      });

      // Prove actual database contention instead of guessing via sleeps.
      // Polling only detects a PostgreSQL Lock wait in the Staff SELECT.
      const waitForStaff = async (count: number) => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const waiting = await pool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_stat_activity
               WHERE application_name=$1 AND wait_event_type='Lock'
                 AND query LIKE '%cookie_staff.staff_profiles%'
                 AND query LIKE '%FOR UPDATE%'`,
            [applicationName],
          );
          if (waiting.rows[0]!.count >= count) return;
          await delay(25);
        }
        assert.fail("Expected real Staff row lock contention");
      };

      type CommandResponse = Awaited<ReturnType<typeof command>>;
      const withStaffLock = async (
        work: (pending: Promise<CommandResponse>[]) => Promise<void>,
      ) => {
        const blocker = await pool.connect();
        const pending: Promise<CommandResponse>[] = [];
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "SELECT id FROM cookie_staff.staff_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
            [tenant, staffId],
          );
          await work(pending);
        } finally {
          try {
            await blocker.query("ROLLBACK");
          } finally {
            blocker.release();
            await Promise.allSettled(pending);
          }
        }
        return Promise.all(pending);
      };

      // Two overlapping mutations of the same Booking must serialize.
      // A move followed by a cancel is valid; a move after cancel is not.
      for (const [offset, first] of [
        [3, "reschedule"],
        [4, "cancel"],
      ] as const) {
        const row = await seed(offset);
        const moveKey = randomUUID();
        const cancelKey = randomUUID();
        const second = first === "reschedule" ? "cancel" : "reschedule";
        const key = (kind: typeof first) =>
          kind === "reschedule" ? moveKey : cancelKey;
        const results = await withStaffLock(async (pending) => {
          pending.push(command(row, first, key(first)));
          await waitForStaff(1);
          pending.push(command(row, second, key(second)));
          await waitForStaff(2);
        });
        const moved = results[first === "reschedule" ? 0 : 1]!;
        const cancelled = results[first === "cancel" ? 0 : 1]!;
        assert.equal(cancelled.statusCode, 200, cancelled.body);
        assert.ok([200, 409].includes(moved.statusCode), moved.body);
        if (moved.statusCode === 409)
          assert.equal(moved.json().error, "BOOKING_NOT_CONFIRMED");
        const moves = moved.statusCode === 200 ? 1 : 0;
        const committed = (await state(row)).rows[0];
        assert.equal(committed.status, "CancelledByBusiness");
        assert.equal(
          committed.start_at.toISOString(),
          moves ? row.target : row.original,
        );
        assert.equal(committed.customer, customerId);
        assert.equal(committed.staff, staffId);
        assert.equal(committed.service, serviceId);
        assert.equal(committed.location, owner.locationId);
        assert.equal(committed.price, "123456");
        assert.equal(
          committed.end_at.getTime() - committed.start_at.getTime(),
          60 * 60000,
        );
        assert.equal(
          committed.occupied_until.getTime() - committed.start_at.getTime(),
          70 * 60000,
        );
        assert.deepEqual((await effects(row)).rows, [
          expectedEffects(moves, 1),
        ]);
        const replay = await command(row, "cancel", cancelKey);
        assert.equal(replay.statusCode, 200, replay.body);
        assert.deepEqual(replay.json(), cancelled.json());
        if (moves) {
          const moveReplay = await command(row, "reschedule", moveKey);
          assert.equal(moveReplay.statusCode, 200, moveReplay.body);
          assert.deepEqual(moveReplay.json(), moved.json());
        }
        assert.deepEqual((await state(row)).rows[0], committed);
        assert.deepEqual((await effects(row)).rows, [
          expectedEffects(moves, 1),
        ]);
      }

      // Revoke the live role after the request has passed AuthN and is waiting
      // on the Staff lock, before the command's transactional authorization.
      const roleRow = await seed(5);
      const roleBefore = (await state(roleRow)).rows;
      const roleKey = randomUUID();
      try {
        const [denied] = await withStaffLock(async (pending) => {
          pending.push(command(roleRow, "reschedule", roleKey));
          await waitForStaff(1);
          await pool.query(
            "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'booking.reschedule') WHERE tenant_id=$1 AND base_type='owner'",
            [tenant],
          );
        });
        assert.equal(denied?.statusCode, 403, denied?.body ?? "Missing response");
        assert.deepEqual((await state(roleRow)).rows, roleBefore);
        assert.deepEqual((await effects(roleRow)).rows, [
          expectedEffects(0, 0),
        ]);
      } finally {
        await pool.query(
          "UPDATE cookie_identity.roles SET permissions=array_append(array_remove(permissions,'booking.reschedule'),'booking.reschedule') WHERE tenant_id=$1 AND base_type='owner'",
          [tenant],
        );
      }
      const retry = await command(roleRow, "reschedule", roleKey);
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(retry.json().startAt, roleRow.target);
      assert.deepEqual((await effects(roleRow)).rows, [expectedEffects(1, 0)]);

      // Same race with a revoked real opaque bearer. No cached AuthN claim
      // may authorize a fresh write after revocation.
      const sessionRow = await seed(6);
      const sessionBefore = (await state(sessionRow)).rows;
      const [denied] = await withStaffLock(async (pending) => {
        pending.push(command(sessionRow, "reschedule", randomUUID()));
        await waitForStaff(1);
        assert.equal(await sessions.revokeBearerToken(bearer), true);
      });
      assert.equal(denied?.statusCode, 403, denied?.body ?? "Missing response");
      assert.deepEqual((await state(sessionRow)).rows, sessionBefore);
      assert.deepEqual((await effects(sessionRow)).rows, [
        expectedEffects(0, 0),
      ]);
      assert.equal(
        (await command(sessionRow, "reschedule", randomUUID())).statusCode,
        401,
      );
    } finally {
      await app.close();
      try {
        if (tenantId)
          await pool.query(
            "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id=$1 AND topic IN ('booking.cancelled','booking.rescheduled')",
            [tenantId],
          );
      } finally {
        await pool.end();
      }
    }
  },
);
