import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { createApp } from "../src/app.js";

test(
  "synthetic F1 HTTP catalog -> availability -> Confirmed -> calendar, conflict and retry",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-booking-http-integration",
      max: 8,
    });
    const tenant = randomUUID();
    const owner = randomUUID();
    const admin = randomUUID();
    const outsider = randomUUID();
    const role = randomUUID();
    const adminRole = randomUUID();
    const locationA = randomUUID();
    const locationB = randomUUID();
    const staff = randomUUID();
    const service = randomUUID();
    const customer = randomUUID();
    const base = `/v1/organizations/${tenant}`;
    const ownerHeader = { authorization: "Bearer synthetic-owner" };
    const createBody = {
      locationId: locationA,
      staffId: staff,
      serviceId: service,
      customerId: customer,
      startAt: "2027-04-12T10:00:00Z",
    };
    let entitlementChecks = 0;
    let cancellationDenied = false;
    let rescheduleDenied = false;
    const verifier = {
      verifyBearerToken: async (token: string) => {
        const identities: Record<string, string> = {
          "synthetic-owner": owner,
          "synthetic-admin": admin,
          "synthetic-outsider": outsider,
        };
        const identityId = identities[token];
        return identityId
          ? {
              identityId,
              tenantId: tenant,
              expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 120,
            }
          : null;
      },
    };
    const app = createApp(pool, {
      syntheticBookingRoutes: {
        pool,
        verifier,
        assertEntitled: async () => {
          entitlementChecks++;
        },
      },
      syntheticWorkspaceReads: { pool, verifier },
      syntheticBookingMutations: {
        pool,
        verifier,
        assertMayCancel: async () => {
          if (cancellationDenied) throw new Error("Synthetic cutoff denied");
        },
        assertMayReschedule: async () => {
          if (rescheduleDenied) throw new Error("Synthetic cutoff denied");
        },
      },
    });
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1),($2),($3)",
        [owner, admin, outsider],
      );
      await pool.query(
        "INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name) VALUES ($1,$2,'HTTP synthetic')",
        [tenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
          VALUES ($1,$2,'A','UTC'),($1,$3,'B','UTC')`,
        [tenant, locationA, locationB],
      );
      await pool.query(
        "INSERT INTO cookie_identity.memberships(tenant_id,identity_id) VALUES ($1,$2),($1,$3)",
        [tenant, owner, admin],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles
           (tenant_id,id,base_type,display_name,permissions)
         VALUES ($1,$2,'owner','Owner',ARRAY['booking.create','booking.read','booking.cancel','booking.reschedule','schedule.read']),
                ($1,$3,'admin','Scoped admin',ARRAY['booking.create','booking.read','schedule.read'])`,
        [tenant, role, adminRole],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments
           (tenant_id,id,identity_id,role_id,location_id)
         VALUES ($1,$2,$3,$4,NULL),($1,$5,$6,$7,$8)`,
        [
          tenant,
          randomUUID(),
          owner,
          role,
          randomUUID(),
          admin,
          adminRole,
          locationA,
        ],
      );
      await pool.query(
        "INSERT INTO cookie_customers.customers(tenant_id,id) VALUES ($1,$2)",
        [tenant, customer],
      );
      await pool.query(
        `INSERT INTO cookie_catalog.services
          (tenant_id,id,display_name,duration_minutes,post_service_buffer_minutes,base_price_kopecks,active)
         VALUES ($1,$2,'Haircut',60,10,150000,true)`,
        [tenant, service],
      );
      await pool.query(
        `INSERT INTO cookie_staff.staff_profiles
          (tenant_id,id,display_name,active,bookable) VALUES ($1,$2,'Alice',true,true)`,
        [tenant, staff],
      );
      await pool.query(
        `INSERT INTO cookie_staff.location_assignments
          (tenant_id,staff_id,location_id,active)
         VALUES ($1,$2,$3,true),($1,$2,$4,true)`,
        [tenant, staff, locationA, locationB],
      );
      await pool.query(
        `INSERT INTO cookie_staff.service_assignments
          (tenant_id,staff_id,location_id,service_id,active)
         VALUES ($1,$2,$3,$5,true),($1,$2,$4,$5,true)`,
        [tenant, staff, locationA, locationB, service],
      );
      await pool.query(
        `INSERT INTO cookie_scheduling.shift_windows
          (tenant_id,id,staff_id,location_id,start_at,end_at,active)
         VALUES ($1,$2,$3,$4,'2027-04-12T09:00:00Z','2027-04-12T18:00:00Z',true),
                ($1,$5,$3,$6,'2027-04-12T09:00:00Z','2027-04-12T18:00:00Z',true)`,
        [tenant, randomUUID(), staff, locationA, randomUUID(), locationB],
      );

      await pool.query(
        `INSERT INTO cookie_scheduling.blocked_windows
          (tenant_id,id,staff_id,location_id,kind,start_at,end_at,active)
         VALUES ($1,$2,$3,$4,'break','2027-04-12T12:00:00Z','2027-04-12T13:00:00Z',true)`,
        [tenant, randomUUID(), staff, locationA],
      );

      const workspace = await app.inject({
        method: "GET",
        url: `${base}/workspace-context`,
        headers: ownerHeader,
      });
      assert.equal(workspace.statusCode, 200);
      assert.equal(workspace.json().organization.organizationId, tenant);
      assert.deepEqual(
        workspace
          .json()
          .locations.map(
            (location: { locationId: string }) => location.locationId,
          )
          .sort(),
        [locationA, locationB].sort(),
      );
      const scopedWorkspace = await app.inject({
        method: "GET",
        url: `${base}/workspace-context`,
        headers: { authorization: "Bearer synthetic-admin" },
      });
      assert.equal(scopedWorkspace.statusCode, 200);
      assert.deepEqual(
        scopedWorkspace
          .json()
          .locations.map(
            (location: { locationId: string }) => location.locationId,
          ),
        [locationA],
      );
      const noWorkspace = await app.inject({
        method: "GET",
        url: `${base}/workspace-context`,
        headers: { authorization: "Bearer synthetic-outsider" },
      });
      assert.equal(noWorkspace.statusCode, 403);
      const scheduleUrl = `${base}/locations/${locationA}/staff/${staff}/schedule?from=2027-04-12T00:00:00Z&to=2027-04-13T00:00:00Z`;
      const schedule = await app.inject({
        method: "GET",
        url: scheduleUrl,
        headers: ownerHeader,
      });
      assert.equal(schedule.statusCode, 200);
      assert.equal(schedule.json().staffId, staff);
      assert.equal(schedule.json().timeZone, "UTC");
      assert.equal(schedule.json().shifts.length, 1);
      assert.deepEqual(
        schedule.json().blocked.map((row: { kind: string }) => row.kind),
        ["break"],
      );
      const scopedSchedule = await app.inject({
        method: "GET",
        url: scheduleUrl,
        headers: { authorization: "Bearer synthetic-admin" },
      });
      assert.equal(scopedSchedule.statusCode, 200);
      const foreignSchedule = await app.inject({
        method: "GET",
        url: `${base}/locations/${locationB}/staff/${staff}/schedule?from=2027-04-12T00:00:00Z&to=2027-04-13T00:00:00Z`,
        headers: { authorization: "Bearer synthetic-admin" },
      });
      assert.equal(foreignSchedule.statusCode, 403);
      assert.equal(foreignSchedule.json().error.code, "ACCESS_DENIED");

      const catalog = await app.inject({
        method: "GET",
        url: `${base}/locations/${locationA}/catalog`,
        headers: ownerHeader,
      });
      assert.equal(catalog.statusCode, 200);
      assert.deepEqual(catalog.json().offers, [
        {
          serviceId: service,
          serviceName: "Haircut",
          staffId: staff,
          staffName: "Alice",
          durationMinutes: 60,
          postServiceBufferMinutes: 10,
          priceKopecks: "150000",
          timeZone: "UTC",
        },
      ]);

      const slotsUrl = `${base}/locations/${locationA}/availability?serviceId=${service}&staffId=${staff}&date=2027-04-12`;
      const availability = await app.inject({
        method: "GET",
        url: slotsUrl,
        headers: ownerHeader,
      });
      assert.equal(availability.statusCode, 200);
      assert.ok(
        availability
          .json()
          .slots.some(
            (slot: { startAt: string }) =>
              slot.startAt === "2027-04-12T10:00:00.000Z",
          ),
      );

      const create = (
        key: string,
        body = createBody,
        token = "synthetic-owner",
      ) =>
        app.inject({
          method: "POST",
          url: `${base}/bookings`,
          headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
          payload: body,
        });
      const [first, competitor] = await Promise.all([
        create("first"),
        create("competitor"),
      ]);
      const resultCodes = [first.statusCode, competitor.statusCode].sort();
      assert.deepEqual(resultCodes, [201, 409]);
      const winning = first.statusCode === 201 ? first : competitor;
      const losing = first.statusCode === 409 ? first : competitor;
      const winningKey = first.statusCode === 201 ? "first" : "competitor";
      assert.equal(losing.json().error.code, "BOOKING_CONFLICT");
      const receipt = winning.json();
      assert.equal(receipt.status, "Confirmed");
      assert.match(receipt.bookingId, /^[0-9a-f-]{36}$/);
      assert.equal(receipt.priceKopecks, "150000");

      const retry = await create(winningKey);
      assert.equal(retry.statusCode, 201);
      assert.deepEqual(retry.json(), receipt);
      assert.equal(
        entitlementChecks,
        2,
        "both new concurrent attempts are checked; replay is not",
      );
      const differentPayload = await create(winningKey, {
        ...createBody,
        startAt: "2027-04-12T14:00:00Z",
      });
      assert.equal(differentPayload.statusCode, 409);
      assert.equal(
        differentPayload.json().error.code,
        "IDEMPOTENCY_KEY_REUSED",
      );

      const booking = await app.inject({
        method: "GET",
        url: `${base}/bookings/${receipt.bookingId}`,
        headers: ownerHeader,
      });
      assert.equal(booking.statusCode, 200);
      assert.equal(booking.json().bookingId, receipt.bookingId);
      assert.equal(booking.json().status, "Confirmed");

      const calendarUrl = `${base}/locations/${locationA}/calendar?from=2027-04-12T00:00:00Z&to=2027-04-13T00:00:00Z`;
      const calendar = await app.inject({
        method: "GET",
        url: calendarUrl,
        headers: ownerHeader,
      });
      assert.equal(calendar.statusCode, 200);
      assert.equal(calendar.json().bookings.length, 1);

      const blockedAvailability = await app.inject({
        method: "GET",
        url: slotsUrl,
        headers: ownerHeader,
      });
      assert.equal(blockedAvailability.statusCode, 200);
      assert.ok(
        !blockedAvailability
          .json()
          .slots.some(
            (slot: { startAt: string }) =>
              slot.startAt === "2027-04-12T10:05:00.000Z",
          ),
      );
      const crossBranch = await create("cross-branch", {
        ...createBody,
        locationId: locationB,
        startAt: "2027-04-12T10:05:00Z",
      });
      assert.equal(crossBranch.statusCode, 409);
      assert.equal(crossBranch.json().error.code, "BOOKING_CONFLICT");

      const adminA = await app.inject({
        method: "GET",
        url: calendarUrl,
        headers: { authorization: "Bearer synthetic-admin" },
      });
      assert.equal(adminA.statusCode, 200);
      const adminB = await app.inject({
        method: "GET",
        url: `${base}/locations/${locationB}/calendar?from=2027-04-12T00:00:00Z&to=2027-04-13T00:00:00Z`,
        headers: { authorization: "Bearer synthetic-admin" },
      });
      assert.equal(adminB.statusCode, 403);
      assert.equal(adminB.json().error.code, "ACCESS_DENIED");
      const outsiderResponse = await create(
        "outsider",
        createBody,
        "synthetic-outsider",
      );
      assert.equal(outsiderResponse.statusCode, 403);
      const foreignTenant = await app.inject({
        method: "GET",
        url: `/v1/organizations/${randomUUID()}/bookings/${receipt.bookingId}`,
        headers: ownerHeader,
      });
      assert.equal(foreignTenant.statusCode, 403);

      await pool.query(
        "UPDATE cookie_identity.memberships SET active=false WHERE tenant_id=$1 AND identity_id=$2",
        [tenant, owner],
      );
      const deniedRetry = await create(winningKey);
      assert.equal(deniedRetry.statusCode, 403);
      await pool.query(
        "UPDATE cookie_identity.memberships SET active=true WHERE tenant_id=$1 AND identity_id=$2",
        [tenant, owner],
      );

      const counts = await pool.query<{
        bookings: string;
        receipts: string;
        events: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM cookie_booking.bookings WHERE tenant_id=$1) AS bookings,
          (SELECT count(*)::text FROM cookie_booking.command_receipts WHERE tenant_id=$1) AS receipts,
          (SELECT count(*)::text FROM cookie_jobs.outbox_events WHERE tenant_id=$1 AND topic='booking.confirmed') AS events`,
        [tenant],
      );
      assert.deepEqual(counts.rows[0], {
        bookings: "1",
        receipts: "1",
        events: "1",
      });

      // Mutations are an independent opt-in business-side surface. Their
      // deadlines are intentionally injected synthetic policies, not defaults.
      const move = (
        key: string,
        body: Record<string, string> = { newStartAt: "2027-04-12T14:00:00Z" },
        token = "synthetic-owner",
      ) =>
        app.inject({
          method: "POST",
          url: `${base}/bookings/${receipt.bookingId}/reschedule`,
          headers: {
            authorization: `Bearer ${token}`,
            "idempotency-key": key,
          },
          payload: body,
        });
      const cancel = (
        key: string,
        body: Record<string, string> = {},
        token = "synthetic-owner",
      ) =>
        app.inject({
          method: "POST",
          url: `${base}/bookings/${receipt.bookingId}/cancel`,
          headers: {
            authorization: `Bearer ${token}`,
            "idempotency-key": key,
          },
          payload: body,
        });

      assert.equal(
        (
          await move("no-id-reassignment", {
            newStartAt: "2027-04-12T14:00:00Z",
            staffId: staff,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (await cancel("no-body-price", { priceKopecks: "0" })).statusCode,
        400,
      );
      assert.equal(
        (await move("scoped-admin", undefined, "synthetic-admin")).statusCode,
        403,
      );
      assert.equal(
        (await cancel("scoped-admin", undefined, "synthetic-admin")).statusCode,
        403,
      );

      rescheduleDenied = true;
      const deniedMove = await move("denied-move");
      assert.equal(deniedMove.statusCode, 403);
      assert.equal(deniedMove.json().error.code, "RESCHEDULE_POLICY_DENIED");
      rescheduleDenied = false;

      const outsideSchedule = await move("outside-shift", {
        newStartAt: "2027-04-12T20:00:00Z",
      });
      assert.equal(outsideSchedule.statusCode, 409);
      assert.equal(outsideSchedule.json().error.code, "BOOKING_CONFLICT");
      const intact = await app.inject({
        method: "GET",
        url: `${base}/bookings/${receipt.bookingId}`,
        headers: ownerHeader,
      });
      assert.equal(intact.json().startAt, receipt.startAt);

      const moved = await move("successful-move");
      assert.equal(moved.statusCode, 200);
      assert.equal(moved.json().bookingId, receipt.bookingId);
      assert.equal(moved.json().status, "Confirmed");
      assert.equal(moved.json().startAt, "2027-04-12T14:00:00.000Z");
      assert.equal(moved.json().priceKopecks, "150000");
      assert.deepEqual((await move("successful-move")).json(), moved.json());
      assert.equal(
        (
          await move("successful-move", { newStartAt: "2027-04-12T15:00:00Z" })
        ).json().error.code,
        "IDEMPOTENCY_KEY_REUSED",
      );

      cancellationDenied = true;
      const deniedCancel = await cancel("denied-cancel");
      assert.equal(deniedCancel.statusCode, 403);
      assert.equal(
        deniedCancel.json().error.code,
        "CANCELLATION_POLICY_DENIED",
      );
      cancellationDenied = false;

      const cancelled = await cancel("successful-cancel");
      assert.equal(cancelled.statusCode, 200);
      assert.equal(cancelled.json().status, "CancelledByBusiness");
      assert.deepEqual(
        (await cancel("successful-cancel")).json(),
        cancelled.json(),
      );
      const afterCancel = await app.inject({
        method: "GET",
        url: `${base}/bookings/${receipt.bookingId}`,
        headers: ownerHeader,
      });
      assert.equal(afterCancel.json().status, "CancelledByBusiness");
      // Historical create receipt never resurrects an already-cancelled booking.
      assert.deepEqual((await create(winningKey)).json(), receipt);
      assert.equal(
        (await cancel("new-cancel-key")).json().error.code,
        "BOOKING_NOT_CONFIRMED",
      );

      // The successful cancellation releases the staff's protected range.
      const rebook = await create("after-cancel-new-create", {
        ...createBody,
        startAt: "2027-04-12T14:00:00Z",
      });
      assert.equal(rebook.statusCode, 201);
      assert.notEqual(rebook.json().bookingId, receipt.bookingId);
      const mutationLedger = await pool.query<{
        bookings: string;
        receipts: string;
        events: string;
        cancels: string;
        reschedules: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM cookie_booking.bookings WHERE tenant_id=$1) AS bookings,
          (SELECT count(*)::text FROM cookie_booking.command_receipts WHERE tenant_id=$1) AS receipts,
          (SELECT count(*)::text FROM cookie_jobs.outbox_events WHERE tenant_id=$1) AS events,
          (SELECT count(*)::text FROM cookie_booking.booking_state_audit WHERE tenant_id=$1) AS cancels,
          (SELECT count(*)::text FROM cookie_booking.time_change_audit WHERE tenant_id=$1) AS reschedules`,
        [tenant],
      );
      assert.deepEqual(mutationLedger.rows[0], {
        bookings: "2",
        receipts: "4",
        events: "4",
        cancels: "1",
        reschedules: "1",
      });
    } finally {
      await app.close();
      const tables = [
        "cookie_booking.command_receipts",
        "cookie_booking.booking_state_audit",
        "cookie_booking.time_change_audit",
        "cookie_jobs.outbox_events",
        "cookie_booking.bookings",
        "cookie_identity.authorization_audit",
        "cookie_scheduling.blocked_windows",
        "cookie_scheduling.shift_windows",
        "cookie_staff.service_assignments",
        "cookie_staff.location_assignments",
        "cookie_staff.staff_profiles",
        "cookie_catalog.services",
        "cookie_customers.customers",
        "cookie_identity.role_assignments",
        "cookie_identity.roles",
        "cookie_identity.memberships",
        "cookie_tenancy.locations",
      ];
      for (const table of tables) {
        await pool
          .query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant])
          .catch(() => undefined);
      }
      await pool
        .query("DELETE FROM cookie_tenancy.organizations WHERE id=$1", [tenant])
        .catch(() => undefined);
      await pool
        .query(
          "DELETE FROM cookie_identity.identities WHERE id=ANY($1::uuid[])",
          [[owner, admin, outsider]],
        )
        .catch(() => undefined);
      await pool.end();
    }
  },
);
