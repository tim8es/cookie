import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createApp } from "../src/app.js";
import { provisionStagingCustomer } from "../../../packages/domain-customers/src/staging-customer.js";
import {
  issueStagingGrant,
  revokeStagingGrant,
} from "../../../packages/domain-entitlement/src/staging.js";
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
  "staging shift publication requires live grant, active assignments, current owner and exact revision",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-staging-shift-publish-test",
      max: 6,
    });
    const ownerId = randomUUID();
    let tenantId: string | undefined;
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
      shiftPlanRoutes: { pool, verifier: sessions },
      stagingPublicationRoutes: { pool, verifier: sessions, enabled: true },
      stagingCustomerBookingRoutes: { pool, verifier: sessions, enabled: true },
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
        organizationName: "Synthetic shift studio",
        locationName: "Synthetic branch",
        timeZone: "Europe/Moscow",
        idempotencyKey: randomUUID(),
      });

      tenantId = owner.tenantId;
      const signed = proof(19190029);
      await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: owner.tenantId,
        ownerIdentityId: ownerId,
        rawInitData: signed,
        consentConfirmed: true,
      });
      const prefix = "/v1/organizations/" + owner.tenantId;
      const url = prefix + "/shift-plans";
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
      const customerProof = proof(19190049);
      const clientContext = await provisionStagingCustomer(
        pool,
        verifier,
        SECRET,
        {
          tenantId: owner.tenantId,
          rawInitData: customerProof,
          consentConfirmed: true,
        },
      );
      const clientLogin = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: customerProof },
      });
      assert.equal(clientLogin.statusCode, 201);
      const clientHeaders = {
        authorization: "Bearer " + clientLogin.json().accessToken,
      };
      const offersUrl = prefix + "/staging-customer-offers";
      const clientOffers = () =>
        app.inject({ method: "GET", url: offersUrl, headers: clientHeaders });
      assert.equal((await clientOffers()).statusCode, 200);
      assert.deepEqual((await clientOffers()).json(), { offers: [] });
      assert.equal(
        (await app.inject({ method: "GET", url: offersUrl, headers }))
          .statusCode,
        403,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: offersUrl })).statusCode,
        401,
      );
      assert.equal(
        (
          await disabled.inject({
            method: "GET",
            url: offersUrl,
            headers: clientHeaders,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: offersUrl.replace(owner.tenantId, randomUUID()),
            headers: clientHeaders,
          })
        ).statusCode,
        403,
      );
      const empty = await app.inject({ method: "GET", url, headers });
      assert.equal(empty.statusCode, 200);
      assert.equal(empty.headers["cache-control"], "no-store");
      assert.deepEqual(empty.json(), { plans: [], hasMore: false });
      const foreign = await app.inject({
        method: "GET",
        url: "/v1/organizations/" + randomUUID() + "/shift-plans",
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
      const date = new Date(Date.now() + 3 * 86400000)
        .toISOString()
        .slice(0, 10);
      const draft = {
        staffId,
        locationId: owner.locationId,
        startLocal: date + "T09:00",
        endLocal: date + "T18:00",
      };
      const makePlan = async (input: typeof draft) => {
        const response = await app.inject({
          method: "POST",
          url,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: input,
        });
        assert.equal(response.statusCode, 201);
        return response.json().plan as { shiftId: string; revision: number };
      };
      const first = await makePlan(draft);
      const serviceId: string = service.json().service.id;
      const previewUrl =
        prefix +
        "/staging-availability?" +
        new URLSearchParams({
          staffId,
          locationId: owner.locationId,
          serviceId,
          localDate: date,
        }).toString();
      const preview = () =>
        app.inject({ method: "GET", url: previewUrl, headers });
      assert.equal(
        (await disabled.inject({ method: "GET", url: previewUrl, headers }))
          .statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: previewUrl })).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: previewUrl.replace(owner.tenantId, randomUUID()),
            headers,
          })
        ).statusCode,
        403,
      );
      assert.equal((await preview()).statusCode, 409);
      const clientSlotsUrl = previewUrl.replace(
        "/staging-availability?",
        "/staging-customer-slots?",
      );
      const clientSlots = () =>
        app.inject({
          method: "GET",
          url: clientSlotsUrl,
          headers: clientHeaders,
        });
      assert.equal((await clientSlots()).statusCode, 409);
      assert.deepEqual((await clientOffers()).json(), { offers: [] });
      assert.equal(
        (await app.inject({ method: "GET", url: clientSlotsUrl, headers }))
          .statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: clientSlotsUrl + "&customerId=" + clientContext.customerId,
            headers: clientHeaders,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: clientSlotsUrl.replace(date, "2026-02-30"),
            headers: clientHeaders,
          })
        ).statusCode,
        400,
      );

      const publishUrl = prefix + "/staging-shift-publication";
      const key = randomUUID();
      const submit = (
        shiftId = first.shiftId,
        revision = first.revision,
        replayKey = key,
      ) =>
        app.inject({
          method: "POST",
          url: publishUrl,
          headers: { ...headers, "idempotency-key": replayKey },
          payload: { shiftId, expectedRevision: revision },
        });
      assert.equal(
        (await disabled.inject({ method: "POST", url: publishUrl })).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ method: "POST", url: publishUrl })).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url:
              "/v1/organizations/" +
              randomUUID() +
              "/staging-shift-publication",
            headers,
            payload: { shiftId: first.shiftId, expectedRevision: 0 },
          })
        ).statusCode,
        403,
      );
      assert.equal((await submit()).json().error, "grant-unavailable");
      await issueStagingGrant(
        pool,
        owner.tenantId,
        1,
        new Date(Date.now() + 3600000).toISOString(),
      );
      assert.equal((await submit()).json().error, "SHIFT_TARGET_UNAVAILABLE");
      const activated = await app.inject({
        method: "POST",
        url: prefix + "/staging-publication",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          staffId,
          locationId: owner.locationId,
          serviceId: service.json().service.id,
          expectedServiceRevision: 0,
        },
      });
      assert.equal(activated.statusCode, 201);
      const offers = await clientOffers();
      assert.equal(offers.statusCode, 200);
      assert.equal(offers.headers["cache-control"], "no-store");
      assert.deepEqual(offers.json(), {
        offers: [
          {
            locationId: owner.locationId,
            locationName: "Synthetic branch",
            staffId,
            staffName: "Synthetic planner staff",
            serviceId,
            serviceName: "Synthetic service",
            timeZone: "Europe/Moscow",
            durationMinutes: 60,
            basePriceKopecks: "100000",
          },
        ],
      });
      assert.deepEqual((await clientSlots()).json(), {
        localDate: date,
        timeZone: "Europe/Moscow",
        slots: [],
      });
      assert.deepEqual((await preview()).json(), {
        localDate: date,
        timeZone: "Europe/Moscow",
        slots: [],
      });
      assert.equal(
        (await submit(first.shiftId, 1)).json().error,
        "SHIFT_STALE_REVISION",
      );
      const [left, right] = await Promise.all([submit(), submit()]);
      assert.equal(left.statusCode, 200);
      assert.equal(right.statusCode, 200);
      assert.deepEqual(left.json(), right.json());
      assert.equal(left.json().publication.active, true);
      assert.equal(left.json().publication.shiftId, first.shiftId);
      assert.deepEqual(
        (await app.inject({ method: "GET", url: publishUrl, headers })).json(),
        { published: [left.json().publication], hasMore: false },
      );
      assert.deepEqual(
        (await app.inject({ method: "GET", url, headers })).json(),
        { plans: [], hasMore: false },
      );
      const other = randomUUID();
      // Trusted synthetic second-location fixture: no new entitlement seat.
      await pool.query(
        "INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone) VALUES($1::uuid,$2::uuid,'Other branch','Europe/Moscow')",
        [owner.tenantId, other],
      );
      await pool.query(
        "INSERT INTO cookie_staff.location_assignments(tenant_id,staff_id,location_id,active) VALUES($1::uuid,$2::uuid,$3::uuid,true)",
        [owner.tenantId, staffId, other],
      );
      await pool.query(
        "INSERT INTO cookie_staff.service_assignments(tenant_id,staff_id,location_id,service_id,active) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,true)",
        [owner.tenantId, staffId, other, service.json().service.id],
      );
      assert.equal((await preview()).json().slots.length, 33);
      assert.equal((await preview()).headers["cache-control"], "no-store");
      // Day is branch-local Moscow time. 09:00 local -> 06:00 UTC.
      const firstSlots = (await preview()).json().slots;
      assert.equal(firstSlots[0].startAt, date + "T06:00:00.000Z");
      // Synthetic fixtures: service buffer, break, and confirmed booking at
      // another branch (including the buffer) reduce available starts.
      await pool.query(
        "UPDATE cookie_catalog.services SET post_service_buffer_minutes=15 WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [owner.tenantId, serviceId],
      );
      await pool.query(
        "INSERT INTO cookie_scheduling.blocked_windows(tenant_id,id,staff_id,location_id,kind,start_at,end_at,active) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'break',$5::timestamptz,$6::timestamptz,true)",
        [
          owner.tenantId,
          randomUUID(),
          staffId,
          owner.locationId,
          date + "T08:00:00Z",
          date + "T09:00:00Z",
        ],
      );
      const customer = randomUUID();
      await pool.query(
        "INSERT INTO cookie_customers.customers(tenant_id,id) VALUES($1::uuid,$2::uuid)",
        [owner.tenantId, customer],
      );
      await pool.query(
        "INSERT INTO cookie_booking.bookings(tenant_id,id,customer_id,staff_id,location_id,service_id,status,start_at,end_at,occupied_until,service_duration_minutes_snapshot,post_service_buffer_minutes_snapshot,price_kopecks_snapshot) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,'Confirmed',$7::timestamptz,$8::timestamptz,$9::timestamptz,60,15,100000)",
        [
          owner.tenantId,
          randomUUID(),
          customer,
          staffId,
          other,
          serviceId,
          date + "T10:00:00Z",
          date + "T11:00:00Z",
          date + "T11:15:00Z",
        ],
      );
      const busy = await preview();
      assert.equal(busy.statusCode, 200);
      const slots = busy.json().slots as Array<{
        startAt: string;
        endAt: string;
        occupiedUntil: string;
      }>;
      assert.equal(slots.length, 15);
      const clientResult = await clientSlots();
      assert.equal(clientResult.statusCode, 200);
      assert.equal(clientResult.headers["cache-control"], "no-store");
      assert.deepEqual(clientResult.json(), {
        localDate: date,
        timeZone: "Europe/Moscow",
        slots: slots.map(({ startAt, endAt }) => ({ startAt, endAt })),
      });
      assert.equal(
        (await clientOffers()).json().offers.length,
        1,
        "plain active placement has no grant receipt",
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: clientSlotsUrl.replace(owner.locationId, other),
            headers: clientHeaders,
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: prefix + "/bookings",
            headers: clientHeaders,
            payload: {},
          })
        ).statusCode,
        404,
      );
      const bookingCount = await pool.query(
        "SELECT count(*)::int AS count FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND customer_id=$2::uuid",
        [owner.tenantId, clientContext.customerId],
      );
      assert.equal(bookingCount.rows[0].count, 0);
      const bookingUrl = prefix + "/staging-customer-bookings";
      const bookingPayload = {
        locationId: owner.locationId,
        staffId,
        serviceId,
        startAt: slots[0]!.startAt,
      };
      const bookingKey = randomUUID();
      const book = (key = bookingKey, payload = bookingPayload) =>
        app.inject({
          method: "POST",
          url: bookingUrl,
          headers: { ...clientHeaders, "idempotency-key": key },
          payload,
        });
      assert.equal(
        (await disabled.inject({ method: "POST", url: bookingUrl })).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ method: "POST", url: bookingUrl })).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: bookingUrl,
            headers: { ...headers, "idempotency-key": bookingKey },
            payload: bookingPayload,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await book(bookingKey, {
            ...bookingPayload,
            customerId: customer,
          } as typeof bookingPayload)
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await book(randomUUID(), { ...bookingPayload, locationId: other })
        ).statusCode,
        409,
      );
      const [created, replayed] = await Promise.all([book(), book()]);
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(replayed.statusCode, 201, replayed.body);
      assert.deepEqual(created.json(), replayed.json());
      assert.equal(created.json().status, "Confirmed");
      assert.equal(created.json().priceKopecks, "100000");
      const persisted = await pool.query(
        `SELECT customer_id::text,status
           FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [owner.tenantId, created.json().bookingId],
      );
      assert.deepEqual(persisted.rows, [
        { customer_id: clientContext.customerId, status: "Confirmed" },
      ]);
      assert.equal((await book(randomUUID())).statusCode, 409);
      assert.equal(
        (
          await book(bookingKey, {
            ...bookingPayload,
            startAt: slots[1]!.startAt,
          })
        ).json().error,
        "IDEMPOTENCY_KEY_REUSED",
      );
      assert.ok(
        !(await clientSlots()).json().slots.some(
          (slot: { startAt: string }) => slot.startAt === bookingPayload.startAt,
        ),
      );
      const durable = await pool.query(
        `SELECT
          (SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1) AS receipts,
          (SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1 AND topic='booking.confirmed') AS events`,
        [owner.tenantId],
      );
      assert.deepEqual(durable.rows[0], { receipts: 1, events: 1 });
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'staging.customer.booking.create') WHERE tenant_id=$1::uuid AND base_type='client'",
        [owner.tenantId],
      );
      assert.equal((await book()).statusCode, 403, "deny even receipt replay");
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_append(permissions,'staging.customer.booking.create') WHERE tenant_id=$1::uuid AND base_type='client'",
        [owner.tenantId],
      );
      // Remove only offers permission. Context remains readable; owner endpoints never widen access.
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'staging.customer.offers.read') WHERE tenant_id=$1::uuid AND base_type='client'",
        [owner.tenantId],
      );
      assert.equal((await clientOffers()).statusCode, 403);
      assert.equal((await clientSlots()).statusCode, 403);
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: prefix + "/staging-customer-context",
            headers: clientHeaders,
          })
        ).statusCode,
        200,
      );
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_append(permissions,'staging.customer.offers.read') WHERE tenant_id=$1::uuid AND base_type='client'",
        [owner.tenantId],
      );
      assert.ok(
        slots.every(
          (s) =>
            s.occupiedUntil <= date + "T08:00:00.000Z" ||
            s.startAt >= date + "T09:00:00.000Z",
        ),
      );
      assert.ok(
        slots.every(
          (s) =>
            s.occupiedUntil <= date + "T10:00:00.000Z" ||
            s.startAt >= date + "T11:15:00.000Z",
        ),
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: previewUrl.replace(owner.locationId, other),
            headers,
          })
        ).statusCode,
        409,
        "plain alternate assignment is not grant-bound",
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: previewUrl.replace(date, "2026-02-30"),
            headers,
          })
        ).statusCode,
        400,
      );
      const competing = await makePlan({ ...draft, locationId: other });
      assert.equal(
        (await submit(competing.shiftId, competing.revision)).json().error,
        "SHIFT_KEY_REUSED",
      );
      assert.equal(
        (
          await submit(competing.shiftId, competing.revision, randomUUID())
        ).json().error,
        "SHIFT_CROSS_LOCATION_CONFLICT",
      );
      const counts = await pool.query(
        `SELECT
          (SELECT count(*)::int FROM cookie_scheduling.shift_windows WHERE tenant_id=$1::uuid AND active) AS shifts,
          (SELECT count(*)::int FROM cookie_scheduling.shift_publish_receipts WHERE tenant_id=$1::uuid) AS receipts,
          (SELECT count(*)::int FROM cookie_scheduling.shift_publish_audit WHERE tenant_id=$1::uuid) AS audits,
          (SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic='schedule.shift.published') AS events`,
        [owner.tenantId],
      );
      assert.deepEqual(counts.rows[0], {
        shifts: 1,
        receipts: 1,
        audits: 1,
        events: 1,
      });
      await pool.query(
        "UPDATE cookie_entitlement.staging_publication_grants SET issued_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1::uuid",
        [owner.tenantId],
      );
      assert.equal((await submit()).json().error, "grant-unavailable");
      assert.equal((await preview()).statusCode, 409);
      assert.deepEqual((await clientOffers()).json(), { offers: [] });
      assert.equal((await clientSlots()).statusCode, 409);
      assert.equal((await book(randomUUID())).json().error, "grant-unavailable");
      await revokeStagingGrant(pool, owner.tenantId);
      assert.deepEqual((await clientOffers()).json(), { offers: [] });
      await app.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers: clientHeaders,
      });
      assert.equal((await clientOffers()).statusCode, 401);
      assert.equal((await clientSlots()).statusCode, 401);
      assert.equal((await preview()).statusCode, 409);
      assert.equal((await submit()).json().error, "grant-unavailable");
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(array_remove(permissions,'staging.shift.publish'),'staging.availability.read') WHERE tenant_id=$1::uuid",
        [owner.tenantId],
      );
      assert.equal((await submit()).statusCode, 403);
      assert.equal((await preview()).statusCode, 403);
      await app.inject({ method: "POST", url: "/v1/auth/logout", headers });
      assert.equal((await submit()).statusCode, 401);
      assert.equal((await preview()).statusCode, 401);
    } finally {
      try {
        await disabled.close();
        await app.close();
        if (tenantId) {
          await pool.query(
            "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic IN ('schedule.shift.draft.created','schedule.shift.published')",
            [tenantId],
          );
        }
      } finally {
        await pool.end();
      }
    }
  },
);
