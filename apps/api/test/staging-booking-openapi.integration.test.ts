import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createApp } from "../src/app.js";
import { provisionStagingCustomer } from "../../../packages/domain-customers/src/staging-customer.js";
import { issueStagingGrant } from "../../../packages/domain-entitlement/src/staging.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { linkVerifiedTelegramOwner } from "../../../packages/platform-identity/src/link-telegram-owner.js";
import { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";
import { provisionOwnerWorkspace } from "../../../packages/platform-identity/src/provision-owner-workspace.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import { createPostgresVerifiedTelegramLinkResolver } from "../../../packages/platform-identity/src/telegram-links.js";
import { assertStagingBookingResponse } from "./staging-booking-contract.js";

const BOT = "123456789:synthetic_booking_contract_not_real";

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
  return new URLSearchParams({ ...fields, hash }).toString();
}

test(
  "staging customer success responses match the OpenAPI contract",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-staging-booking-contract",
      max: 6,
    });
    const secret = randomBytes(32);
    const verifier = createTelegramMiniAppProofVerifier({
      botToken: BOT,
      maxAgeSeconds: 300,
    });
    const sessions = new PostgresOpaqueTelegramSessions({
      pool,
      telegramProofVerifier: verifier,
      fingerprintSecret: secret,
      resolveVerifiedTelegramLink: createPostgresVerifiedTelegramLinkResolver({
        userHashSecret: secret,
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
      stagingCustomerCancellationRoutes: {
        pool,
        verifier: sessions,
        enabled: true,
        cutoffMinutes: 60,
      },
      stagingCustomerRescheduleRoutes: {
        pool,
        verifier: sessions,
        enabled: true,
        cutoffMinutes: 30,
      },
    });
    let tenantId: string | undefined;
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const ownerIdentityId = randomUUID();
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [ownerIdentityId],
      );
      const owner = await provisionOwnerWorkspace(pool, {
        ownerIdentityId,
        organizationName: "Synthetic contract studio",
        locationName: "Synthetic UTC branch",
        timeZone: "UTC",
        idempotencyKey: randomUUID(),
      });
      tenantId = owner.tenantId;
      const tenant = owner.tenantId;
      const prefix = "/v1/organizations/" + tenant;
      const signed = proof(19192001);
      await linkVerifiedTelegramOwner(pool, verifier, secret, {
        tenantId: tenant,
        ownerIdentityId,
        rawInitData: signed,
        consentConfirmed: true,
      });
      async function login(initData: string): Promise<string> {
        const response = await app.inject({
          method: "POST",
          url: "/v1/auth/telegram/exchange",
          payload: { initData },
        });
        assert.equal(response.statusCode, 201);
        assert.equal(typeof response.json().accessToken, "string");
        return response.json().accessToken as string;
      }
      const ownerToken = await login(signed);
      const post = (
        url: string,
        token: string,
        payload: object,
        key: string = randomUUID(),
      ) =>
        app.inject({
          method: "POST",
          url: prefix + url,
          headers: {
            authorization: "Bearer " + token,
            "idempotency-key": key,
          },
          payload,
        });
      const service = await post("/services", ownerToken, {
        displayName: "Synthetic contract service",
        durationMinutes: 60,
        basePriceKopecks: 100000,
      });
      assert.equal(service.statusCode, 201);
      const serviceId: string = service.json().service.id;
      const staff = await post("/staff", ownerToken, {
        displayName: "Synthetic contract staff",
        positionTitle: "Stylist",
        locationId: owner.locationId,
        serviceId,
      });
      assert.equal(staff.statusCode, 201);
      const staffId: string = staff.json().staff.id;
      const date = new Date(Date.now() + 3 * 86400000)
        .toISOString()
        .slice(0, 10);
      const draft = await post("/shift-plans", ownerToken, {
        staffId,
        locationId: owner.locationId,
        startLocal: date + "T09:00",
        endLocal: date + "T18:00",
      });
      assert.equal(draft.statusCode, 201);
      await issueStagingGrant(
        pool,
        tenant,
        1,
        new Date(Date.now() + 3600000).toISOString(),
      );
      assert.equal(
        (
          await post("/staging-publication", ownerToken, {
            staffId,
            locationId: owner.locationId,
            serviceId,
            expectedServiceRevision: 0,
          })
        ).statusCode,
        201,
      );
      assert.equal(
        (
          await post("/staging-shift-publication", ownerToken, {
            shiftId: draft.json().plan.shiftId,
            expectedRevision: draft.json().plan.revision,
          })
        ).statusCode,
        200,
      );

      const rawInitData = proof(19192002);
      await provisionStagingCustomer(pool, verifier, secret, {
        tenantId: tenant,
        rawInitData,
        consentConfirmed: true,
      });
      const token = await login(rawInitData);
      const headers = { authorization: "Bearer " + token };
      const get = (route: string, extra: Record<string, string> = {}) =>
        app.inject({
          method: "GET",
          url: prefix + "/" + route,
          headers: { ...headers, ...extra },
        });
      const offers = await get("staging-customer-offers");
      assertStagingBookingResponse(
        "staging-customer-offers",
        "get",
        200,
        offers,
      );
      assert.equal(offers.json().offers.length, 1);
      const selection = { locationId: owner.locationId, staffId, serviceId };
      const query = new URLSearchParams({ ...selection, localDate: date });
      const slots = await get("staging-customer-slots?" + query.toString());
      assertStagingBookingResponse("staging-customer-slots", "get", 200, slots);
      assert.ok(slots.json().slots.length > 0);
      const createCapability = "staging-customer-bookings/capability";
      assertStagingBookingResponse(
        createCapability,
        "get",
        200,
        await get(createCapability),
      );
      const createKey = randomUUID();
      const created = await post(
        "/staging-customer-bookings",
        token,
        { ...selection, startAt: date + "T09:00:00.000Z" },
        createKey,
      );
      assertStagingBookingResponse(
        "staging-customer-bookings",
        "post",
        201,
        created,
      );
      const receiptRoute = "staging-customer-bookings/receipt";
      const receipt = await get(receiptRoute, { "idempotency-key": createKey });
      assertStagingBookingResponse(receiptRoute, "get", 200, receipt);
      assert.deepEqual(receipt.json(), created.json());
      const historyRoute = "staging-customer-history";
      const history = await get(historyRoute);
      assertStagingBookingResponse(historyRoute, "get", 200, history);
      assert.equal(history.json().bookings.length, 1);
      const bookingId: string = created.json().bookingId;
      assert.equal(history.json().bookings[0].bookingId, bookingId);
      const moveSlotsRoute = "staging-customer-reschedule/{bookingId}/slots";
      const moveSlots = await get(
        "staging-customer-reschedule/" + bookingId + "/slots?localDate=" + date,
      );
      assertStagingBookingResponse(moveSlotsRoute, "get", 200, moveSlots);
      assert.equal(moveSlots.json().localDate, date);
      assert.equal(moveSlots.json().timeZone, "UTC");
      assert.ok(moveSlots.json().slots.length > 0);
      assert.ok(
        !moveSlots
          .json()
          .slots.some(
            (slot: { startAt: string }) =>
              slot.startAt === created.json().startAt,
          ),
      );
      const moveCapability = "staging-customer-reschedule/capability";
      const capability = await get(moveCapability);
      assertStagingBookingResponse(moveCapability, "get", 200, capability);
      assert.deepEqual(capability.json(), { cutoffMinutes: 30 });

      const moveRoute = "staging-customer-reschedule/{bookingId}";
      const moveUrl = "/staging-customer-reschedule/" + bookingId;
      const newStartAt = date + "T12:00:00.000Z";
      assert.ok(
        moveSlots.json().slots.some(
          (slot: { startAt: string }) => slot.startAt === newStartAt,
        ),
      );
      const moveKey = randomUUID();
      const moved = await post(moveUrl, token, { newStartAt }, moveKey);
      assertStagingBookingResponse(moveRoute, "post", 200, moved);
      assert.deepEqual(moved.json(), {
        bookingId,
        status: "Confirmed",
        previousStartAt: created.json().startAt,
        startAt: newStartAt,
        endAt: date + "T13:00:00.000Z",
        occupiedUntil: date + "T13:00:00.000Z",
        priceKopecks: created.json().priceKopecks,
      });
      const replay = await post(moveUrl, token, { newStartAt }, moveKey);
      assertStagingBookingResponse(moveRoute, "post", 200, replay);
      assert.deepEqual(replay.json(), moved.json());
      const changedReplay = await post(
        moveUrl,
        token,
        { newStartAt: date + "T14:00:00.000Z" },
        moveKey,
      );
      assertStagingBookingResponse(moveRoute, "post", 409, changedReplay);
      assert.deepEqual(changedReplay.json(), {
        error: "IDEMPOTENCY_KEY_REUSED",
      });

      const movedHistory = await get(historyRoute);
      assertStagingBookingResponse(historyRoute, "get", 200, movedHistory);
      assert.deepEqual(movedHistory.json().bookings, [
        {
          ...history.json().bookings[0],
          startAt: newStartAt,
          endAt: moved.json().endAt,
        },
      ]);
      // The original Create receipt remains a committed historical result,
      // not a mutable projection of the current booking.
      const originalReceipt = await get(receiptRoute, {
        "idempotency-key": createKey,
      });
      assertStagingBookingResponse(receiptRoute, "get", 200, originalReceipt);
      assert.deepEqual(originalReceipt.json(), created.json());

      const cancelCapability = "staging-customer-cancellation/capability";
      assertStagingBookingResponse(
        cancelCapability,
        "get",
        200,
        await get(cancelCapability),
      );
      const cancelled = await post(
        "/staging-customer-cancellation/" + bookingId,
        token,
        {},
      );
      assertStagingBookingResponse(
        "staging-customer-cancellation/{bookingId}",
        "post",
        200,
        cancelled,
      );
      assert.equal(cancelled.json().bookingId, bookingId);
      const finalHistory = await get(historyRoute);
      assertStagingBookingResponse(historyRoute, "get", 200, finalHistory);
      assert.deepEqual(finalHistory.json().bookings, [
        {
          ...movedHistory.json().bookings[0],
          status: "CancelledByClient",
        },
      ]);
    } finally {
      try {
        await app.close();
        if (tenantId) {
          await pool.query(
            "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid",
            [tenantId],
          );
        }
      } finally {
        await pool.end();
      }
    }
  },
);
