import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createApp } from "../src/app.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { linkVerifiedTelegramOwner } from "../../../packages/platform-identity/src/link-telegram-owner.js";
import { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";
import { provisionOwnerWorkspace } from "../../../packages/platform-identity/src/provision-owner-workspace.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import {
  createPostgresVerifiedTelegramLinkResolver,
  telegramUserFingerprint,
} from "../../../packages/platform-identity/src/telegram-links.js";
import { withTenantPermission } from "../src/protected-tenant-transaction.js";
import { verifyTenantActor } from "../src/session-context.js";

const BOT = "123456789:synthetic_calendar_detail_not_real_bot";
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
  "owner booking details preserve snapshots and reject wrong scope",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-owner-calendar-detail-test",
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
      fingerprintSecret: SECRET,
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
      ownerCalendar: { pool, verifier: sessions },
      stagingOwnerCalendarCancellation: {
        pool, verifier: sessions, enabled: true, cutoffMinutes: 0,
      },
    });
    const disabled = createApp(pool);
    const cutoffDenied = createApp(pool, {
      stagingOwnerCalendarCancellation: {
        pool, verifier: sessions, enabled: true, cutoffMinutes: 525600,
      },
    });
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [ownerId],
      );
      const owner = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: ownerId,
        organizationName: "Synthetic detail studio",
        locationName: "Synthetic branch",
        timeZone: "America/New_York",
        idempotencyKey: randomUUID(),
      });

      const signed = proof(19193039);
      await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: owner.tenantId,
        ownerIdentityId: ownerId,
        rawInitData: signed,
        consentConfirmed: true,
      });
      const prefix = "/v1/organizations/" + owner.tenantId;
      const calendarUrl = prefix + "/owner-calendar";
      const exchange = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: signed },
      });
      assert.equal(exchange.statusCode, 201);
      const headers = {
        authorization: "Bearer " + exchange.json().accessToken,
      };
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
      assert.equal(service.statusCode, 201);
      const staff = await app.inject({
        method: "POST",
        url: prefix + "/staff",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          displayName: "Synthetic planner staff",
          positionTitle: "Stylist",
          locationId: owner.locationId,
          serviceId: service.json().service.id,
        },
      });
      assert.equal(staff.statusCode, 201);
      const staffId: string = staff.json().staff.id;
      const tenant = owner.tenantId;
      const serviceId: string = service.json().service.id;
      const customerId = randomUUID();
      await pool.query(
        "INSERT INTO cookie_customers.customers(tenant_id,id) VALUES($1::uuid,$2::uuid)",
        [tenant, customerId],
      );
      const otherBranch = randomUUID();
      await pool.query(
        "INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone) VALUES($1::uuid,$2::uuid,'Other branch','America/New_York')",
        [tenant, otherBranch],
      );
      await pool.query(
        "INSERT INTO cookie_staff.location_assignments(tenant_id,staff_id,location_id) VALUES($1::uuid,$2::uuid,$3::uuid)",
        [tenant, staffId, otherBranch],
      );
      await pool.query(
        "INSERT INTO cookie_staff.service_assignments(tenant_id,staff_id,location_id,service_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)",
        [tenant, staffId, otherBranch, serviceId],
      );

      // These are isolated persisted synthetic records, not a real booking command.
      const seed = async (
        startAt: string,
        status: string,
        locationId = owner.locationId,
      ) => {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO cookie_booking.bookings
           (tenant_id,id,customer_id,staff_id,location_id,service_id,status,
            start_at,end_at,occupied_until,service_duration_minutes_snapshot,
            post_service_buffer_minutes_snapshot,price_kopecks_snapshot,cancelled_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,
            $8::timestamptz+interval '60 minutes',$8::timestamptz+interval '70 minutes',
            60,10,123456,CASE WHEN $7='CancelledByBusiness' THEN clock_timestamp() ELSE NULL END)`,
          [
            tenant,
            id,
            customerId,
            staffId,
            locationId,
            serviceId,
            status,
            startAt,
          ],
        );
        return id;
      };
      const bookingId = await seed("2027-03-14T12:00:00Z", "Confirmed");
      const cancelled = await seed(
        "2027-03-15T03:00:00Z",
        "CancelledByBusiness",
      );
      const other = await seed(
        "2027-03-14T15:00:00Z",
        "Completed",
        otherBranch,
      );
      const detailUrl = (id: string, branch = owner.locationId) =>
        calendarUrl + "/" + id + "?locationId=" + branch;
      const read = (path = detailUrl(bookingId)) =>
        app.inject({ method: "GET", url: path, headers });
      const path = detailUrl(bookingId);
      assert.equal(
        (await disabled.inject({ method: "GET", url: path })).statusCode,
        404,
      );
      const anonymous = await app.inject({ method: "GET", url: path });
      assert.equal(anonymous.statusCode, 401);
      const response = await read();
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers.vary, "Authorization");
      assert.deepEqual(response.json(), {
        id: bookingId,
        locationId: owner.locationId,
        timeZone: "America/New_York",
        status: "Confirmed",
        startAt: "2027-03-14T12:00:00.000Z",
        endAt: "2027-03-14T13:00:00.000Z",
        occupiedUntil: "2027-03-14T13:10:00.000Z",
        cancelledAt: null,
        durationMinutes: 60,
        bufferMinutes: 10,
        staffName: "Synthetic planner staff",
        serviceName: "Synthetic service",
        priceKopecks: "123456",
      });
      assert.ok(!response.body.includes(customerId));
      const missing = await read(detailUrl(randomUUID()));
      assert.equal(missing.statusCode, 404);
      assert.deepEqual(missing.json(), { error: "booking-not-found" });
      const wrongBranch = await read(detailUrl(other));
      assert.equal(wrongBranch.statusCode, 404);
      assert.deepEqual(wrongBranch.json(), missing.json());
      const inOtherBranch = await read(detailUrl(other, otherBranch));
      assert.equal(inOtherBranch.statusCode, 200);
      const foreign = await read(path.replace(tenant, randomUUID()));
      assert.equal(foreign.statusCode, 403);
      const injected = await read(path + "&customerId=" + customerId);
      assert.equal(injected.statusCode, 400);
      assert.equal((await read(detailUrl("invalid"))).statusCode, 400);
      const cancellation = await read(detailUrl(cancelled));
      assert.equal(cancellation.statusCode, 200);
      assert.equal(cancellation.json().status, "CancelledByBusiness");
      assert.ok(Number.isFinite(Date.parse(cancellation.json().cancelledAt)));
      // Model a same-tenant admin who actually has organization booking.read.
      // The fixture provisions a verified link; normal exchange verifies proof.
      const adminId = randomUUID();
      const roleId = randomUUID();
      const adminTelegramId = 19193040;
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [adminId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES($1::uuid,$2::uuid)`,
        [tenant, adminId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles
           (tenant_id,id,base_type,display_name,permissions)
         VALUES($1::uuid,$2::uuid,'admin','Synthetic reader',ARRAY['booking.read'])`,
        [tenant, roleId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments
           (tenant_id,id,identity_id,role_id)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
        [tenant, randomUUID(), adminId, roleId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.telegram_identity_links
           (tenant_id,id,identity_id,telegram_user_hmac_sha256,
            proof_verified_at,consent_confirmed_at)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::bytea,now(),now())`,
        [
          tenant,
          randomUUID(),
          adminId,
          telegramUserFingerprint(SECRET, String(adminTelegramId)),
        ],
      );
      const adminExchange = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: proof(adminTelegramId) },
      });
      assert.equal(adminExchange.statusCode, 201);
      const adminHeaders = {
        authorization: "Bearer " + adminExchange.json().accessToken,
      };
      const verified = await verifyTenantActor(
        adminHeaders.authorization,
        tenant,
        sessions,
      );
      assert.ok(verified.actor);
      assert.equal(verified.actor.identityId, adminId);
      assert.equal(
        await withTenantPermission(
          pool,
          verified.actor,
          "booking.read",
          async () => true,
        ),
        true,
      );
      const adminDenied = await app.inject({
        method: "GET",
        url: path,
        headers: adminHeaders,
      });
      assert.equal(adminDenied.statusCode, 403);
      assert.deepEqual(adminDenied.json(), { error: "forbidden" });
      assert.equal(adminDenied.headers["cache-control"], "no-store");
      // Existing-Booking owner edit: no new publication grant, no default
      // business policy, and no customer PII in either capability or receipt.
      const futureStart = new Date(Date.now() + 7 * 86400000)
        .toISOString().slice(0, 16) + ":00Z";
      const mutable = await seed(futureStart, "Confirmed");
      const ownerCancel = calendarUrl + "/" + mutable + "/cancel?locationId=" + owner.locationId;
      const capability = calendarUrl + "/cancellation/capability";
      const key = randomUUID();
      const cancel = (url = ownerCancel, currentKey = key, instance = app, currentHeaders = headers) =>
        instance.inject({
          method: "POST", url,
          headers: { ...currentHeaders, "idempotency-key": currentKey },
          payload: {},
        });
      assert.equal((await disabled.inject({
        method: "GET", url: capability, headers,
      })).statusCode, 404);
      assert.equal((await disabled.inject({
        method: "POST", url: ownerCancel, headers, payload: {},
      })).statusCode, 404);
      assert.deepEqual((await app.inject({
        method: "GET", url: capability, headers,
      })).json(), { cutoffMinutes: 0 });
      assert.equal((await app.inject({
        method: "GET", url: capability,
      })).statusCode, 401);
      assert.equal((await app.inject({
        method: "GET", url: capability, headers: adminHeaders,
      })).statusCode, 403);
      assert.equal((await cancel(ownerCancel, key, app, adminHeaders)).statusCode, 403);
      assert.equal((await cancel(ownerCancel.replace(tenant, randomUUID()))).statusCode, 403);
      assert.equal((await cancel(ownerCancel.replace(owner.locationId, otherBranch))).statusCode, 404);
      assert.equal((await cancel(calendarUrl + "/" + randomUUID() + "/cancel?locationId=" + owner.locationId)).statusCode, 404);
      assert.equal((await cancel(ownerCancel + "&customerId=" + customerId)).statusCode, 400);
      assert.equal((await cancel(ownerCancel, key, cutoffDenied)).statusCode, 409);
      assert.equal((await app.inject({
        method: "POST", url: ownerCancel, headers,
        payload: {},
      })).statusCode, 400);
      assert.equal((await app.inject({
        method: "POST", url: ownerCancel,
        headers: { "idempotency-key": key }, payload: {},
      })).statusCode, 401);
      const unmodified = await pool.query(
        "SELECT status FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [tenant, mutable],
      );
      assert.equal(unmodified.rows[0]?.status, "Confirmed");
      const before = await pool.query(
        "SELECT (SELECT count(*)::int FROM cookie_booking.booking_state_audit WHERE tenant_id=$1::uuid AND booking_id=$2::uuid) AS audits,(SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1::uuid AND booking_id=$2::uuid AND operation='booking.cancel') AS receipts,(SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic='booking.cancelled' AND payload->>'bookingId'=$2::text) AS events",
        [tenant, mutable],
      );
      assert.deepEqual(before.rows[0], { audits: 0, receipts: 0, events: 0 });
      const [done, replay] = await Promise.all([cancel(), cancel()]);
      assert.equal(done.statusCode, 200, done.body);
      assert.deepEqual(replay.json(), done.json());
      assert.equal(done.json().bookingId, mutable);
      assert.equal(done.json().status, "CancelledByBusiness");
      assert.ok(Number.isFinite(Date.parse(done.json().cancelledAt)));
      const after = await pool.query(
        "SELECT status,price_kopecks_snapshot::text AS price,start_at FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [tenant, mutable],
      );
      assert.equal(after.rows[0]?.status, "CancelledByBusiness");
      assert.equal(after.rows[0]?.price, "123456");
      assert.equal(after.rows[0]?.start_at.toISOString(), new Date(futureStart).toISOString());
      const effects = await pool.query(
        "SELECT (SELECT count(*)::int FROM cookie_booking.booking_state_audit WHERE tenant_id=$1::uuid AND booking_id=$2::uuid) AS audits,(SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1::uuid AND booking_id=$2::uuid AND operation='booking.cancel') AS receipts,(SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic='booking.cancelled' AND payload->>'bookingId'=$2::text) AS events",
        [tenant, mutable],
      );
      assert.deepEqual(effects.rows[0], { audits: 1, receipts: 1, events: 1 });
      assert.equal((await cancel(ownerCancel, randomUUID())).statusCode, 409);
      assert.deepEqual((await cancel()).json(), done.json());
      assert.deepEqual((await pool.query(
        "SELECT status FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [tenant, mutable],
      )).rows, [{ status: "CancelledByBusiness" }]);
      assert.deepEqual((await pool.query(
        "SELECT (SELECT count(*)::int FROM cookie_booking.booking_state_audit WHERE tenant_id=$1::uuid AND booking_id=$2::uuid) AS audits,(SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1::uuid AND booking_id=$2::uuid AND operation='booking.cancel') AS receipts,(SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic='booking.cancelled' AND payload->>'bookingId'=$2::text) AS events",
        [tenant, mutable],
      )).rows[0], effects.rows[0]);
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'booking.cancel') WHERE tenant_id=$1::uuid",
        [tenant],
      );
      assert.equal((await cancel()).statusCode, 403, "Same-key replay must not bypass revoked booking.cancel");
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_append(permissions,'booking.cancel') WHERE tenant_id=$1::uuid",
        [tenant],
      );
      assert.deepEqual((await read()).json(), response.json());
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'booking.read') WHERE tenant_id=$1::uuid",
        [tenant],
      );
      assert.equal((await read()).statusCode, 403);
      await app.inject({ method: "POST", url: "/v1/auth/logout", headers });
      assert.equal((await read()).statusCode, 401);
    } finally {
      await cutoffDenied.close();
      await disabled.close();
      await app.close();
      await pool.end();
    }
  },
);
