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
import { createPostgresVerifiedTelegramLinkResolver } from "../../../packages/platform-identity/src/telegram-links.js";

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
    });
    const disabled = createApp(pool);
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
      assert.equal((await read(detailUrl(other, otherBranch))).statusCode, 200);
      const foreign = await read(path.replace(tenant, randomUUID()));
      assert.equal(foreign.statusCode, 403);
      const injected = await read(path + "&customerId=" + customerId);
      assert.equal(injected.statusCode, 400);
      assert.equal((await read(detailUrl("invalid"))).statusCode, 400);
      const cancellation = await read(detailUrl(cancelled));
      assert.equal(cancellation.statusCode, 200);
      assert.equal(cancellation.json().status, "CancelledByBusiness");
      assert.ok(Number.isFinite(Date.parse(cancellation.json().cancelledAt)));
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'booking.read') WHERE tenant_id=$1::uuid",
        [tenant],
      );
      assert.equal((await read()).statusCode, 403);
      await app.inject({ method: "POST", url: "/v1/auth/logout", headers });
      assert.equal((await read()).statusCode, 401);
    } finally {
      await disabled.close();
      await app.close();
      await pool.end();
    }
  },
);
