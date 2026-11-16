import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { BookingAttempt } from "../../web/src/lib/booking-attempt.js";
import { createProposedF1SyntheticLoopbackClient } from "../../web/src/lib/proposed-f1-synthetic-loopback.js";
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

      // Real TCP transport stays bound to ephemeral localhost in CI only.
      // Production main.ts does not mount these injected synthetic routes.
      const loopbackOrigin = await app.listen({ host: "127.0.0.1", port: 0 });

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
      assert.equal(schedule.statusCode, 200, schedule.body);
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
      assert.equal(availability.json().priceKopecks, "150000");
      const unassignedOffer = await app.inject({
        method: "GET",
        url: `${base}/locations/${locationA}/availability?serviceId=${randomUUID()}&staffId=${staff}&date=2027-04-12`,
        headers: ownerHeader,
      });
      assert.equal(unassignedOffer.statusCode, 200);
      assert.deepEqual(unassignedOffer.json(), {
        slots: [],
        priceKopecks: null,
      });
      const unauthorizedPriceRead = await app.inject({
        method: "GET",
        url: slotsUrl,
        headers: { authorization: "Bearer synthetic-outsider" },
      });
      assert.equal(unauthorizedPriceRead.statusCode, 403);
      assert.ok(
        availability
          .json()
          .slots.some(
            (slot: { startAt: string }) =>
              slot.startAt === "2027-04-12T10:00:00.000Z",
          ),
      );

      const quoteUrl = (startAt: string) =>
        `${base}/locations/${locationA}/quote?serviceId=${service}&staffId=${staff}&date=2027-04-12&startAt=${startAt}`;
      const beforeQuote = await app.inject({
        method: "GET",
        url: quoteUrl("2027-04-12T10:00:00Z"),
        headers: ownerHeader,
      });
      assert.equal(beforeQuote.statusCode, 200);
      assert.deepEqual(beforeQuote.json(), {
        locationId: locationA,
        serviceId: service,
        staffId: staff,
        startAt: "2027-04-12T10:00:00.000Z",
        endAt: "2027-04-12T11:00:00.000Z",
        occupiedUntil: "2027-04-12T11:10:00.000Z",
        durationMinutes: 60,
        postServiceBufferMinutes: 10,
        timeZone: "UTC",
        priceKopecks: "150000",
        currency: "RUB",
        priceKind: "base-service",
        provisional: true,
      });
      const deniedQuote = await app.inject({
        method: "GET",
        url: quoteUrl("2027-04-12T10:00:00Z"),
        headers: { authorization: "Bearer synthetic-outsider" },
      });
      assert.equal(deniedQuote.statusCode, 403);
      assert.equal(deniedQuote.json().error.code, "ACCESS_DENIED");

      // All create assertions (including concurrent same-slot creates, replay
      // and revocation) exercise the real HTTP listener rather than inject.
      const networkCatalog = await fetch(
        `${loopbackOrigin}${base}/locations/${locationA}/catalog`,
        { headers: ownerHeader },
      );
      assert.equal(networkCatalog.status, 200);
      assert.deepEqual(await networkCatalog.json(), catalog.json());
      const networkAvailability = await fetch(`${loopbackOrigin}${slotsUrl}`, {
        headers: ownerHeader,
      });
      assert.equal(networkAvailability.status, 200);
      assert.deepEqual(await networkAvailability.json(), availability.json());

      const create = async (
        key: string,
        body = createBody,
        token = "synthetic-owner",
      ) => {
        const response = await fetch(`${loopbackOrigin}${base}/bookings`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "idempotency-key": key,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const responseBody = await response.text();
        return {
          statusCode: response.status,
          json: () => JSON.parse(responseBody),
        };
      };
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
      const quotedAfterBooking = await app.inject({
        method: "GET",
        url: quoteUrl("2027-04-12T10:00:00Z"),
        headers: ownerHeader,
      });
      assert.equal(quotedAfterBooking.statusCode, 409);
      assert.equal(quotedAfterBooking.json().error.code, "BOOKING_CONFLICT");

      // Deliberately discard a successful replay's response body, then
      // reconcile by the same key. This is NOT a lost-COMMIT/TCP-reset test.
      const unreadReplay = await fetch(`${loopbackOrigin}${base}/bookings`, {
        method: "POST",
        headers: {
          ...ownerHeader,
          "idempotency-key": winningKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(createBody),
      });
      assert.equal(unreadReplay.status, 201);
      await unreadReplay.body?.cancel();

      const retry = await create(winningKey);
      assert.equal(retry.statusCode, 201);
      assert.deepEqual(retry.json(), receipt);
      // A subsequent service price change is visible in availability, but
      // does not mutate an already-committed Booking or replayed receipt.
      await pool.query(
        "UPDATE cookie_catalog.services SET base_price_kopecks=199900 WHERE tenant_id=$1 AND id=$2",
        [tenant, service],
      );
      const reQuoted = await app.inject({
        method: "GET",
        url: slotsUrl,
        headers: ownerHeader,
      });
      assert.equal(reQuoted.statusCode, 200);
      assert.equal(reQuoted.json().priceKopecks, "199900");
      // Quote uses current catalog price, while idempotent replay remains
      // bound to the original committed receipt, not this provisional read.
      const repricedQuote = await app.inject({
        method: "GET",
        url: quoteUrl("2027-04-12T14:00:00Z"),
        headers: ownerHeader,
      });
      assert.equal(repricedQuote.statusCode, 200);
      assert.equal(repricedQuote.json().priceKopecks, "199900");
      assert.equal(repricedQuote.json().provisional, true);
      assert.deepEqual((await create(winningKey)).json(), receipt);
      await pool.query(
        "UPDATE cookie_catalog.services SET base_price_kopecks=150000 WHERE tenant_id=$1 AND id=$2",
        [tenant, service],
      );
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
      const networkBooking = await fetch(
        `${loopbackOrigin}${base}/bookings/${receipt.bookingId}`,
        { headers: ownerHeader },
      );
      assert.equal(networkBooking.status, 200);
      assert.deepEqual(await networkBooking.json(), booking.json());

      const calendarUrl = `${base}/locations/${locationA}/calendar?from=2027-04-12T00:00:00Z&to=2027-04-13T00:00:00Z`;
      const calendar = await app.inject({
        method: "GET",
        url: calendarUrl,
        headers: ownerHeader,
      });
      assert.equal(calendar.statusCode, 200);
      assert.equal(calendar.json().bookings.length, 1);
      const networkCalendar = await fetch(`${loopbackOrigin}${calendarUrl}`, {
        headers: ownerHeader,
      });
      assert.equal(networkCalendar.status, 200);
      assert.deepEqual(await networkCalendar.json(), calendar.json());

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

      // Cross-stack contract gate: execute the EXACT frontend #119 loopback
      // adapter and #106 BookingAttempt state machine against this real
      // Fastify TCP listener and real PostgreSQL state, not a stubbed fetch.
      const selection = {
        locationId: locationA,
        staffId: staff,
        serviceId: service,
        localDate: "2027-04-12",
        startAt: "2027-04-12T16:00:00Z",
      };
      // Static imports verify the SAME frontend port with NodeNext types and tsx runtime.
      let discardedCommittedReply = false;
      const frontend = createProposedF1SyntheticLoopbackClient({
        origin: loopbackOrigin,
        tenantId: tenant,
        syntheticCustomerId: customer,
        syntheticBearer: "synthetic-owner",
        fetcher: async (input, init) => {
          const response = await fetch(input, init);
          if (!discardedCommittedReply && init?.method === "POST") {
            assert.equal(response.status, 201);
            await response.body?.cancel();
            discardedCommittedReply = true;
            throw new Error("synthetic client discarded committed HTTP reply");
          }
          return response;
        },
      });
      const beforeSubmit = await frontend.readAvailability(selection);
      assert.equal(beforeSubmit.priceKopecks, "150000");
      assert.ok(
        beforeSubmit.slots.some(
          (slot: { startAt: string }) =>
            slot.startAt === "2027-04-12T16:00:00.000Z",
        ),
      );
      // A read-side price is not a guaranteed F2 Quote. The current DB
      // price at COMMIT must win and appear in the verified frontend receipt.
      await pool.query(
        "UPDATE cookie_catalog.services SET base_price_kopecks=175555 WHERE tenant_id=$1 AND id=$2",
        [tenant, service],
      );
      const attempt = new BookingAttempt(frontend.port, () => "ui-wire-loss");
      const unknownOutcome = await attempt.submit(selection);
      assert.equal(unknownOutcome.phase, "error");
      if (unknownOutcome.phase !== "error") throw new Error("expected error");
      assert.equal(unknownOutcome.reason, "network");
      assert.equal(unknownOutcome.retryable, true);
      assert.equal(discardedCommittedReply, true);
      assert.equal(attempt.reset(), false, "uncertain COMMIT blocks new key");
      const recovered = await attempt.retry();
      assert.equal(recovered.phase, "confirmed");
      if (recovered.phase !== "confirmed")
        throw new Error("frontend may only accept verified Confirmed");
      assert.match(recovered.receipt.bookingId, /^[0-9a-f-]{36}$/);
      assert.equal(recovered.receipt.finalPriceText, "1\u00a0755,55 ₽");
      assert.equal(recovered.receipt.dateTimeText, "12.04.2027, 16:00 UTC");
      const historicalReplay = await frontend.port.create(
        selection,
        "ui-wire-loss",
      );
      assert.deepEqual(
        frontend.port.verifyConfirmed(historicalReplay),
        recovered.receipt,
      );

      // A separate frontend attempt at an occupied slot gets a verified
      // BOOKING_CONFLICT and refreshes the ACTUAL backend availability.
      const normalClient = createProposedF1SyntheticLoopbackClient({
        origin: loopbackOrigin,
        tenantId: tenant,
        syntheticCustomerId: customer,
        syntheticBearer: "synthetic-owner",
        fetcher: fetch,
      });
      const competingAttempt = new BookingAttempt(
        normalClient.port,
        () => "ui-wire-competing",
      );
      const conflicted = await competingAttempt.submit(selection);
      assert.equal(conflicted.phase, "conflict");
      if (conflicted.phase !== "conflict") throw new Error("expected conflict");
      assert.equal(conflicted.refreshFailed, false);
      assert.ok(
        !conflicted.slots.some(
          (slot: { startAt: string }) =>
            slot.startAt === "2027-04-12T16:00:00.000Z",
        ),
      );
      const outsiderClient = createProposedF1SyntheticLoopbackClient({
        origin: loopbackOrigin,
        tenantId: tenant,
        syntheticCustomerId: customer,
        syntheticBearer: "synthetic-outsider",
        fetcher: fetch,
      });
      const outsiderAttempt = new BookingAttempt(
        outsiderClient.port,
        () => "ui-wire-forbidden",
      );
      assert.deepEqual(await outsiderAttempt.submit(selection), {
        phase: "denied",
        reason: "forbidden",
      });
      const bridgeLedger = await pool.query<{
        bookings: string;
        receipts: string;
        events: string;
        committed_price: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM cookie_booking.bookings WHERE tenant_id=$1) AS bookings,
          (SELECT count(*)::text FROM cookie_booking.command_receipts WHERE tenant_id=$1) AS receipts,
          (SELECT count(*)::text FROM cookie_jobs.outbox_events WHERE tenant_id=$1) AS events,
          (SELECT price_kopecks_snapshot::text FROM cookie_booking.bookings
             WHERE tenant_id=$1 AND start_at='2027-04-12T16:00:00Z'::timestamptz) AS committed_price`,
        [tenant],
      );
      assert.deepEqual(bridgeLedger.rows[0], {
        bookings: "3",
        receipts: "5",
        events: "5",
        committed_price: "175555",
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
