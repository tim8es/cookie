import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
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
  "real owner calendar reads bounded local days and preserved Booking snapshots without a grant",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-owner-calendar-test",
      max: 6,
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
      ownerCalendar: { pool, verifier: sessions },
    });
    const disabled = createApp(pool);
    const replayApp = createApp(pool, {
      stagingOwnerCalendarReschedule: {
        pool,
        verifier: sessions,
        enabled: true,
        cutoffMinutes: 525600,
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
        organizationName: "Synthetic shift studio",
        locationName: "Synthetic branch",
        timeZone: "America/New_York",
        idempotencyKey: randomUUID(),
      });

      const signed = proof(19190039);
      await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: owner.tenantId,
        ownerIdentityId: ownerId,
        rawInitData: signed,
        consentConfirmed: true,
      });
      const prefix = "/v1/organizations/" + owner.tenantId;
      const calendarUrl = prefix + "/owner-calendar";
      const url =
        calendarUrl +
        "?locationId=" +
        owner.locationId +
        "&date=2027-03-14&days=1";
      assert.equal(
        (await disabled.inject({ method: "GET", url })).statusCode,
        404,
      );
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
      const exchange = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: signed },
      });
      assert.equal(exchange.statusCode, 201);
      const headers = {
        authorization: "Bearer " + exchange.json().accessToken,
      };
      const empty = await app.inject({ method: "GET", url, headers });
      assert.equal(empty.statusCode, 200);
      assert.equal(empty.headers["cache-control"], "no-store");
      assert.deepEqual(empty.json(), {
        locationId: owner.locationId,
        localDate: "2027-03-14",
        days: 1,
        timeZone: "America/New_York",
        entries: [],
      });
      const foreign = await app.inject({
        method: "GET",
        url:
          "/v1/organizations/" +
          randomUUID() +
          "/owner-calendar?locationId=" +
          owner.locationId +
          "&date=2027-03-14&days=1",
        headers,
      });
      assert.equal(foreign.statusCode, 403);

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
      // New York spring-forward: 05:00Z to next day 04:00Z (23 hours).
      const carry = await seed("2027-03-14T04:30:00Z", "Completed");
      const confirmed = await seed("2027-03-14T12:00:00Z", "Confirmed");
      const cancelled = await seed(
        "2027-03-15T03:00:00Z",
        "CancelledByBusiness",
      );
      const next = await seed("2027-03-15T04:00:00Z", "NoShow");
      await seed("2027-03-14T04:00:00Z", "Completed");
      const outside = await seed(
        "2027-03-14T15:00:00Z",
        "Completed",
        otherBranch,
      );
      const read = async (path = url) =>
        app.inject({ method: "GET", url: path, headers });
      const day = await read();
      assert.equal(day.statusCode, 200);
      assert.deepEqual(
        day.json().entries.map((entry: { id: string }) => entry.id),
        [carry, confirmed, cancelled],
      );
      const record = day.json().entries[1];
      assert.deepEqual(record, {
        id: confirmed,
        status: "Confirmed",
        startAt: "2027-03-14T12:00:00.000Z",
        endAt: "2027-03-14T13:00:00.000Z",
        staffName: "Synthetic planner staff",
        serviceName: "Synthetic service",
        priceKopecks: "123456",
      });
      assert.ok(!day.body.includes(customerId));
      assert.ok(!day.body.includes(outside));
      assert.deepEqual(
        (await read(url.replace("days=1", "days=7")))
          .json()
          .entries.map((entry: { id: string }) => entry.id),
        [carry, confirmed, cancelled, next],
      );
      assert.deepEqual(
        (await read(url.replace(owner.locationId, otherBranch)))
          .json()
          .entries.map((entry: { id: string }) => entry.id),
        [outside],
      );
      assert.equal(
        (await read(url.replace(owner.locationId, randomUUID()))).statusCode,
        404,
      );
      for (const invalid of [
        url.replace("2027-03-14", "2027-02-30"),
        url.replace("days=1", "days=8"),
        url + "&days=7",
        url + "&customerId=" + customerId,
      ])
        assert.equal((await read(invalid)).statusCode, 400);

      // Read works without staging grant and without active offers. No Booking
      // write route is wired, and no customer field is returned.
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: calendarUrl,
            headers,
            payload: {},
          })
        ).statusCode,
        404,
      );
      // A synthetic persisted receipt represents a previously committed move.
      // This isolates the real authorized replay from availability and policy
      // setup. The large cutoff deliberately forbids a new move at this date.
      const moveKey = randomUUID();
      const newStartAt = record.startAt;
      const priorReceipt = {
        bookingId: confirmed,
        status: "Confirmed",
        previousStartAt: "2027-03-14T10:00:00.000Z",
        startAt: newStartAt,
        endAt: record.endAt,
        occupiedUntil: "2027-03-14T13:10:00.000Z",
        priceKopecks: record.priceKopecks,
      };
      const hash = (value: string) =>
        createHash("sha256").update(value, "utf8").digest("hex");
      await pool.query(
        `INSERT INTO cookie_booking.command_receipts
           (tenant_id,actor_identity_id,operation,key_sha256,request_sha256,
            booking_id,result)
         VALUES ($1::uuid,$2::uuid,'booking.reschedule',$3,$4,$5::uuid,$6::jsonb)`,
        [
          tenant,
          ownerId,
          hash(moveKey),
          hash(JSON.stringify([confirmed, newStartAt, "staging.owner"])),
          confirmed,
          JSON.stringify(priorReceipt),
        ],
      );
      const replay = (branchId = owner.locationId) =>
        replayApp.inject({
          method: "POST",
          url:
            calendarUrl +
            "/" +
            confirmed +
            "/reschedule?locationId=" +
            branchId,
          headers: { ...headers, "idempotency-key": moveKey },
          payload: { newStartAt },
        });
      const original = await replay();
      assert.equal(original.statusCode, 200, original.body);
      assert.deepEqual(original.json(), priorReceipt);
      const wrongBranch = await replay(otherBranch);
      assert.equal(wrongBranch.statusCode, 403, wrongBranch.body);
      assert.deepEqual(wrongBranch.json(), { error: "forbidden" });

      // Change only synthetic ownership, retaining the old bearer/membership
      // and role grants. A cached result must not bypass current owner scope.
      const replacementOwner = randomUUID();
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [replacementOwner],
      );
      await pool.query(
        "INSERT INTO cookie_identity.memberships(tenant_id,identity_id) VALUES($1::uuid,$2::uuid)",
        [tenant, replacementOwner],
      );
      await pool.query(
        "UPDATE cookie_tenancy.organizations SET owner_identity_id=$2::uuid WHERE id=$1::uuid",
        [tenant, replacementOwner],
      );
      try {
        const formerOwner = await replay();
        assert.equal(formerOwner.statusCode, 403, formerOwner.body);
        assert.deepEqual(formerOwner.json(), { error: "forbidden" });
      } finally {
        await pool.query(
          "UPDATE cookie_tenancy.organizations SET owner_identity_id=$2::uuid WHERE id=$1::uuid",
          [tenant, ownerId],
        );
      }
      const restoredOwner = await replay();
      assert.equal(restoredOwner.statusCode, 200, restoredOwner.body);
      assert.deepEqual(restoredOwner.json(), priorReceipt);
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'booking.reschedule') WHERE tenant_id=$1::uuid",
        [tenant],
      );
      assert.equal((await replay()).statusCode, 403);

      const effects = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM cookie_booking.command_receipts
             WHERE tenant_id=$1::uuid AND booking_id=$2::uuid
               AND operation='booking.reschedule') AS receipts,
           (SELECT count(*)::int FROM cookie_booking.time_change_audit
             WHERE tenant_id=$1::uuid AND booking_id=$2::uuid) AS audits,
           (SELECT count(*)::int FROM cookie_jobs.outbox_events
             WHERE tenant_id=$1::uuid AND topic='booking.rescheduled'
               AND payload->>'bookingId'=$2::text) AS events`,
        [tenant, confirmed],
      );
      assert.deepEqual(effects.rows, [{ receipts: 1, audits: 0, events: 0 }]);
      assert.deepEqual((await read()).json().entries[1], record);

      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'booking.read') WHERE tenant_id=$1::uuid",
        [tenant],
      );
      assert.equal((await read()).statusCode, 403);
      await app.inject({ method: "POST", url: "/v1/auth/logout", headers });
      assert.equal((await read()).statusCode, 401);
      assert.equal((await replay()).statusCode, 401);
    } finally {
      await replayApp.close();
      await disabled.close();
      await app.close();
      await pool.end();
    }
  },
);
