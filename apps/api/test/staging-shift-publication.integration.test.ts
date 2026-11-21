import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

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
        pool, verifier: sessions, enabled: true, cutoffMinutes: 30,
      },
    });
    const disabled = createApp(pool);
    const cutoffDenied = createApp(pool, {
      stagingCustomerCancellationRoutes: {
        pool,
        verifier: sessions,
        enabled: true,
        cutoffMinutes: 525600,
      },
      stagingCustomerRescheduleRoutes: {
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
      // Deny a real verified owner while the draft/target/grant are valid.
      // The denial must commit its sanitized audit, never publication.
      const deniedAudit = async () =>
        (
          await pool.query(
            `SELECT permission,allowed,reason,location_id::text
               FROM cookie_identity.authorization_audit
              WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid
                AND permission='staging.shift.publish' AND NOT allowed
              ORDER BY id`,
            [owner.tenantId, ownerId],
          )
        ).rows;
      const publicationEffects = async () =>
        (
          await pool.query(
            `SELECT
               (SELECT active FROM cookie_scheduling.shift_windows
                 WHERE tenant_id=$1::uuid AND id=$2::uuid) AS active,
               (SELECT count(*)::int FROM cookie_scheduling.shift_publish_receipts
                 WHERE tenant_id=$1::uuid AND shift_id=$2::uuid) AS receipts,
               (SELECT count(*)::int FROM cookie_scheduling.shift_publish_audit
                 WHERE tenant_id=$1::uuid AND shift_id=$2::uuid) AS audits,
               (SELECT count(*)::int FROM cookie_jobs.outbox_events
                 WHERE tenant_id=$1::uuid AND topic='schedule.shift.published'
                   AND payload->>'shiftId'=($2::uuid)::text) AS events`,
            [owner.tenantId, first.shiftId],
          )
        ).rows;
      const initialDenials = await deniedAudit();
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'staging.shift.publish') WHERE tenant_id=$1::uuid AND base_type='owner'",
        [owner.tenantId],
      );
      const denied = await submit();
      assert.equal(denied.statusCode, 403);
      assert.deepEqual(denied.json(), { error: "forbidden" });
      assert.equal(denied.headers["cache-control"], "no-store");
      const afterDenial = await deniedAudit();
      assert.deepEqual(afterDenial, [
        ...initialDenials,
        {
          permission: "staging.shift.publish",
          allowed: false,
          reason: "owner-required",
          location_id: owner.locationId,
        },
      ]);
      const noPublication = [
        { active: false, receipts: 0, audits: 0, events: 0 },
      ];
      assert.deepEqual(await publicationEffects(), noPublication);

      // Abort the denied-audit transaction immediately before COMMIT.
      // A rolled-back audit cannot be presented as an acknowledged 403.
      const completion: string[] = [];
      const faultPool = {
        async connect(): Promise<PoolClient> {
          const physical = await pool.connect();
          return {
            async query(sql: string, params?: unknown[]): Promise<unknown> {
              if (sql === "COMMIT") {
                await assert.rejects(physical.query("SELECT 1 / 0"), {
                  code: "22012",
                });
                const result = await physical.query(sql, params);
                completion.push(result.command);
                return result;
              }
              return physical.query(sql, params);
            },
            release(discard?: boolean): void {
              completion.push(discard ? "discard" : "reuse");
              physical.release(discard);
            },
          } as unknown as PoolClient;
        },
      } as unknown as Pool;
      const faulty = createApp(pool, {
        stagingPublicationRoutes: {
          pool: faultPool,
          verifier: sessions,
          enabled: true,
        },
      });
      try {
        const unavailable = await faulty.inject({
          method: "POST",
          url: publishUrl,
          headers: { ...headers, "idempotency-key": key },
          payload: {
            shiftId: first.shiftId,
            expectedRevision: first.revision,
          },
        });
        assert.equal(unavailable.statusCode, 503);
        assert.deepEqual(unavailable.json(), { error: "unavailable" });
      } finally {
        await faulty.close();
      }
      assert.deepEqual(completion, ["ROLLBACK", "discard"]);
      assert.deepEqual(await deniedAudit(), afterDenial);
      assert.deepEqual(await publicationEffects(), noPublication);
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_append(permissions,'staging.shift.publish') WHERE tenant_id=$1::uuid AND base_type='owner'",
        [owner.tenantId],
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
      const historyUrl = prefix + "/staging-customer-history";
      const history = () =>
        app.inject({ method: "GET", url: historyUrl, headers: clientHeaders });
      assert.deepEqual((await history()).json(), {
        bookings: [],
        hasMore: false,
      });
      const ownerHistory = await app.inject({
        method: "GET",
        url: historyUrl,
        headers,
      });
      assert.equal(ownerHistory.statusCode, 403);
      const foreignHistory = await app.inject({
        method: "GET",
        url: historyUrl.replace(owner.tenantId, randomUUID()),
        headers: clientHeaders,
      });
      assert.equal(foreignHistory.statusCode, 403);
      const forgedHistory = await app.inject({
        method: "GET",
        url: historyUrl + "?customerId=" + customer,
        headers: clientHeaders,
      });
      assert.equal(forgedHistory.statusCode, 400);
      const noHistorySession = await app.inject({
        method: "GET",
        url: historyUrl,
      });
      assert.equal(noHistorySession.statusCode, 401);
      const disabledHistory = await disabled.inject({
        method: "GET",
        url: historyUrl,
        headers: clientHeaders,
      });
      assert.equal(disabledHistory.statusCode, 404);
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
      const recoveryUrl = bookingUrl + "/receipt";
      const recover = (key: string = bookingKey) =>
        app.inject({
          method: "GET",
          url: recoveryUrl,
          headers: { ...clientHeaders, "idempotency-key": key },
        });
      const missingReceipt = await recover();
      assert.equal(missingReceipt.statusCode, 404);
      const disabledReceipt = await disabled.inject({
        method: "GET",
        url: recoveryUrl,
        headers: { ...clientHeaders, "idempotency-key": bookingKey },
      });
      assert.equal(disabledReceipt.statusCode, 404);
      const anonymousReceipt = await app.inject({
        method: "GET",
        url: recoveryUrl,
      });
      assert.equal(anonymousReceipt.statusCode, 401);
      const disabledBooking = await disabled.inject({
        method: "POST",
        url: bookingUrl,
      });
      assert.equal(disabledBooking.statusCode, 404);
      const anonymousBooking = await app.inject({
        method: "POST",
        url: bookingUrl,
      });
      assert.equal(anonymousBooking.statusCode, 401);
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
      const forgedCustomer = { ...bookingPayload, customerId: customer };
      assert.equal((await book(bookingKey, forgedCustomer)).statusCode, 400);
      const otherPlacement = { ...bookingPayload, locationId: other };
      const rejectedPlacement = await book(randomUUID(), otherPlacement);
      assert.equal(rejectedPlacement.statusCode, 409);
      const [created, replayed] = await Promise.all([book(), book()]);
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(replayed.statusCode, 201, replayed.body);
      assert.deepEqual(created.json(), replayed.json());
      assert.equal(created.json().status, "Confirmed");
      assert.equal(created.json().priceKopecks, "100000");
      const recovered = await recover();
      assert.equal(recovered.statusCode, 200);
      assert.equal(recovered.headers["cache-control"], "no-store");
      assert.deepEqual(recovered.json(), created.json());
      assert.equal((await recover(randomUUID())).statusCode, 404);
      const ownerReceipt = await app.inject({
        method: "GET",
        url: recoveryUrl,
        headers: { ...headers, "idempotency-key": bookingKey },
      });
      assert.equal(ownerReceipt.statusCode, 403);
      const foreignReceipt = await app.inject({
        method: "GET",
        url: recoveryUrl.replace(owner.tenantId, randomUUID()),
        headers: { ...clientHeaders, "idempotency-key": bookingKey },
      });
      assert.equal(foreignReceipt.statusCode, 403);
      const invalidRecovery = await app.inject({
        method: "GET",
        url: recoveryUrl + "?customerId=" + customer,
        headers: { ...clientHeaders, "idempotency-key": bookingKey },
      });
      assert.equal(invalidRecovery.statusCode, 400);
      const persisted = await pool.query(
        `SELECT customer_id::text,status
           FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [owner.tenantId, created.json().bookingId],
      );
      assert.deepEqual(persisted.rows, [
        { customer_id: clientContext.customerId, status: "Confirmed" },
      ]);
      assert.equal((await book(randomUUID())).statusCode, 409);
      const changedSlot = { ...bookingPayload, startAt: slots[1]!.startAt };
      const keyConflict = await book(bookingKey, changedSlot);
      assert.equal(keyConflict.json().error, "IDEMPOTENCY_KEY_REUSED");
      const refreshedSlots = (await clientSlots()).json().slots as Array<{
        startAt: string;
      }>;
      assert.ok(
        !refreshedSlots.some((slot) => slot.startAt === bookingPayload.startAt),
      );
      const durable = await pool.query(
        `SELECT
          (SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1) AS receipts,
          (SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1 AND topic='booking.confirmed') AS events`,
        [owner.tenantId],
      );
      assert.deepEqual(durable.rows[0], { receipts: 1, events: 1 });
      const ownHistory = await history();
      assert.equal(ownHistory.statusCode, 200);
      assert.equal(ownHistory.headers["cache-control"], "no-store");
      assert.deepEqual(ownHistory.json(), {
        bookings: [
          {
            bookingId: created.json().bookingId,
            status: "Confirmed",
            startAt: created.json().startAt,
            endAt: created.json().endAt,
            priceKopecks: "100000",
            locationName: "Synthetic branch",
            serviceName: "Synthetic service",
            staffName: "Synthetic planner staff",
            timeZone: "Europe/Moscow",
          },
        ],
        hasMore: false,
      });
      const beforeHistoryDenial = await history();
      assert.equal(beforeHistoryDenial.statusCode, 200);
      assert.equal(beforeHistoryDenial.json().bookings[0].status, "Confirmed");
      const historyDenials = async () =>
        (
          await pool.query(
            `SELECT a.permission,a.allowed,a.reason,a.location_id
               FROM cookie_identity.authorization_audit a
               JOIN cookie_customers.staging_customer_identities c
                 ON c.tenant_id=a.tenant_id
                AND c.identity_id=a.actor_identity_id
              WHERE c.tenant_id=$1::uuid AND c.customer_id=$2::uuid
                AND a.permission='staging.customer.bookings.read'
                AND NOT a.allowed ORDER BY a.id`,
            [owner.tenantId, clientContext.customerId],
          )
        ).rows;
      const priorHistoryDenials = await historyDenials();
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'staging.customer.bookings.read') WHERE tenant_id=$1::uuid AND base_type='client'",
        [owner.tenantId],
      );
      const deniedHistory = await history();
      assert.equal(deniedHistory.statusCode, 403);
      assert.deepEqual(deniedHistory.json(), { error: "forbidden" });
      assert.equal(deniedHistory.headers["cache-control"], "no-store");
      const expectedHistoryDenials = [
        ...priorHistoryDenials,
        {
          permission: "staging.customer.bookings.read",
          allowed: false,
          reason: "permission-denied",
          location_id: null,
        },
      ];
      assert.deepEqual(await historyDenials(), expectedHistoryDenials);
      const readableContext = await app.inject({
        method: "GET",
        url: prefix + "/staging-customer-context",
        headers: clientHeaders,
      });
      assert.equal(readableContext.statusCode, 200);
      assert.deepEqual(readableContext.json(), clientContext);
      const crossTenantHistory = await app.inject({
        method: "GET",
        url: historyUrl.replace(owner.tenantId, randomUUID()),
        headers: clientHeaders,
      });
      assert.equal(crossTenantHistory.statusCode, 403);
      assert.deepEqual(await historyDenials(), expectedHistoryDenials);
      const faultyHistory = createApp(pool, {
        stagingPublicationRoutes: {
          pool: faultPool,
          verifier: sessions,
          enabled: true,
        },
      });
      completion.length = 0;
      try {
        const failed = await faultyHistory.inject({
          method: "GET",
          url: historyUrl,
          headers: clientHeaders,
        });
        assert.equal(failed.statusCode, 503);
        assert.deepEqual(failed.json(), { error: "unavailable" });
      } finally {
        await faultyHistory.close();
      }
      assert.deepEqual(completion, ["ROLLBACK", "discard"]);
      assert.deepEqual(await historyDenials(), expectedHistoryDenials);
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_append(permissions,'staging.customer.bookings.read') WHERE tenant_id=$1::uuid AND base_type='client'",
        [owner.tenantId],
      );
      const restoredHistory = await history();
      assert.equal(restoredHistory.statusCode, 200);
      assert.deepEqual(restoredHistory.json(), beforeHistoryDenial.json());
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'staging.customer.booking.create') WHERE tenant_id=$1::uuid AND base_type='client'",
        [owner.tenantId],
      );
      assert.equal((await book()).statusCode, 403, "deny even receipt replay");
      assert.equal((await recover()).statusCode, 403);
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_append(permissions,'staging.customer.booking.create') WHERE tenant_id=$1::uuid AND base_type='client'",
        [owner.tenantId],
      );
      // Remove only offers permission. Context remains readable; owner endpoints never widen access.
      const clientIdentity = await pool.query<{ identity_id: string }>(
        `SELECT identity_id::text FROM cookie_customers.staging_customer_identities
          WHERE tenant_id=$1::uuid AND customer_id=$2::uuid`,
        [owner.tenantId, clientContext.customerId],
      );
      const readDenials = async () =>
        (
          await pool.query(
            `SELECT permission,allowed,reason,location_id
               FROM cookie_identity.authorization_audit
              WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid
                AND permission IN ('staging.customer.context.read',
                                   'staging.customer.offers.read')
                AND NOT allowed ORDER BY id`,
            [owner.tenantId, clientIdentity.rows[0]!.identity_id],
          )
        ).rows;
      const initialReadDenials = await readDenials();
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'staging.customer.offers.read') WHERE tenant_id=$1::uuid AND base_type='client'",
        [owner.tenantId],
      );
      for (const request of [clientOffers, clientSlots]) {
        const denial = await request();
        assert.equal(denial.statusCode, 403);
        assert.deepEqual(denial.json(), { error: "forbidden" });
        assert.equal(denial.headers["cache-control"], "no-store");
      }
      const offersDenial = {
        permission: "staging.customer.offers.read",
        allowed: false,
        reason: "permission-denied",
        location_id: null,
      };
      const expectedOfferDenials = [
        ...initialReadDenials,
        offersDenial,
        offersDenial,
      ];
      assert.deepEqual(await readDenials(), expectedOfferDenials);
      const foreignRead = await app.inject({
        method: "GET",
        url: offersUrl.replace(owner.tenantId, randomUUID()),
        headers: clientHeaders,
      });
      assert.equal(foreignRead.statusCode, 403);
      assert.deepEqual(await readDenials(), expectedOfferDenials);
      const failedReadAudit = createApp(pool, {
        stagingPublicationRoutes: {
          pool: faultPool,
          verifier: sessions,
          enabled: true,
        },
      });
      completion.length = 0;
      try {
        const failed = await failedReadAudit.inject({
          method: "GET",
          url: offersUrl,
          headers: clientHeaders,
        });
        assert.equal(failed.statusCode, 503);
        assert.deepEqual(failed.json(), { error: "unavailable" });
      } finally {
        await failedReadAudit.close();
      }
      assert.deepEqual(completion, ["ROLLBACK", "discard"]);
      assert.deepEqual(await readDenials(), expectedOfferDenials);
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
      assert.equal((await clientOffers()).statusCode, 200);
      assert.equal((await clientSlots()).statusCode, 200);
      const clientContextUrl = prefix + "/staging-customer-context";
      const readContext = () =>
        app.inject({
          method: "GET",
          url: clientContextUrl,
          headers: clientHeaders,
        });
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'staging.customer.context.read') WHERE tenant_id=$1::uuid AND base_type='client'",
        [owner.tenantId],
      );
      const contextDenied = await readContext();
      assert.equal(contextDenied.statusCode, 403);
      assert.deepEqual(contextDenied.json(), { error: "forbidden" });
      assert.equal(contextDenied.headers["cache-control"], "no-store");
      assert.deepEqual(await readDenials(), [
        ...expectedOfferDenials,
        { ...offersDenial, permission: "staging.customer.context.read" },
      ]);
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_append(permissions,'staging.customer.context.read') WHERE tenant_id=$1::uuid AND base_type='client'",
        [owner.tenantId],
      );
      assert.deepEqual((await readContext()).json(), clientContext);
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
      // Real independent signed Customer sessions contend for the same
      // currently available interval, using the SAME key across identities.
      // Existing single-customer/idempotency assertions above are retained.
      const available = (await clientSlots()).json().slots as Array<{
        startAt: string;
      }>;
      assert.ok(available.length > 0);
      const racePayload = {
        ...bookingPayload,
        startAt: available[available.length - 1]!.startAt,
      };
      const raceKey = randomUUID();
      const contenders: Array<{
        customerId: string;
        authorization: string;
      }> = [];
      for (let index = 0; index < 12; index++) {
        const signedCustomer = proof(19220000 + index);
        const context = await provisionStagingCustomer(pool, verifier, SECRET, {
          tenantId: owner.tenantId,
          rawInitData: signedCustomer,
          consentConfirmed: true,
        });
        const login = await app.inject({
          method: "POST",
          url: "/v1/auth/telegram/exchange",
          payload: { initData: signedCustomer },
        });
        assert.equal(login.statusCode, 201);
        contenders.push({
          customerId: context.customerId,
          authorization: "Bearer " + login.json().accessToken,
        });
      }
      assert.equal(new Set(contenders.map((c) => c.customerId)).size, 12);
      const raceBook = (authorization: string) =>
        app.inject({
          method: "POST",
          url: bookingUrl,
          headers: { authorization, "idempotency-key": raceKey },
          payload: racePayload,
        });
      const races = await Promise.all(
        contenders.map(async (c) => ({
          customerId: c.customerId,
          authorization: c.authorization,
          responses: await Promise.all([
            raceBook(c.authorization),
            raceBook(c.authorization),
          ]),
        })),
      );
      const winners = races.filter((c) =>
        c.responses.some((response) => response.statusCode === 201),
      );
      assert.equal(winners.length, 1, "Only one Customer may win the slot");
      const winner = winners[0]!;
      const winnerResponses = winner.responses;
      assert.ok(winnerResponses.every((r) => r.statusCode === 201));
      assert.deepEqual(winnerResponses[0]!.json(), winnerResponses[1]!.json());
      const receipt = winnerResponses[0]!.json();
      assert.equal(receipt.status, "Confirmed");
      assert.equal(receipt.startAt, racePayload.startAt);
      assert.equal(receipt.priceKopecks, "100000");
      for (const contender of races) {
        if (contender.customerId === winner.customerId) continue;
        for (const response of contender.responses) {
          assert.equal(response.statusCode, 409, response.body);
          assert.ok(
            ["BOOKING_NOT_AVAILABLE", "BOOKING_CONFLICT"].includes(
              response.json().error,
            ),
          );
        }
      }
      const owned = await pool.query(
        `SELECT customer_id::text,status FROM cookie_booking.bookings
            WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [owner.tenantId, receipt.bookingId],
      );
      assert.deepEqual(owned.rows, [
        { customer_id: winner.customerId, status: "Confirmed" },
      ]);
      const raceState = await pool.query(
        `SELECT
          (SELECT count(*)::int FROM cookie_booking.bookings
            WHERE tenant_id=$1::uuid AND customer_id=ANY($2::uuid[])) AS bookings,
          (SELECT count(*)::int FROM cookie_booking.command_receipts
            WHERE tenant_id=$1::uuid) AS receipts,
          (SELECT count(*)::int FROM cookie_jobs.outbox_events
            WHERE tenant_id=$1::uuid AND topic='booking.confirmed') AS events`,
        [owner.tenantId, contenders.map((c) => c.customerId)],
      );
      assert.deepEqual(raceState.rows[0], {
        bookings: 1,
        receipts: 2,
        events: 2,
      });
      const eventForWinner = await pool.query(
        `SELECT count(*)::int AS count FROM cookie_jobs.outbox_events
           WHERE tenant_id=$1::uuid AND topic='booking.confirmed'
             AND payload->>'bookingId'=$2`,
        [owner.tenantId, receipt.bookingId],
      );
      assert.equal(eventForWinner.rows[0].count, 1);
      assert.deepEqual((await raceBook(winner.authorization)).json(), receipt);
      const afterRace = (await clientSlots()).json().slots as Array<{
        startAt: string;
      }>;
      assert.ok(!afterRace.some((s) => s.startAt === racePayload.startAt));
      for (const c of contenders) {
        await app.inject({
          method: "POST",
          url: "/v1/auth/logout",
          headers: { authorization: c.authorization },
        });
      }
      console.log("PASS: 12 signed customers, 24 requests, one slot winner");

      const cancellationRoot = prefix + "/staging-customer-cancellation";
      const cancelUrl = cancellationRoot + "/" + created.json().bookingId;
      const cancelKey = randomUUID();
      const cancel = (key: string = cancelKey, target = cancelUrl) =>
        app.inject({
          method: "POST",
          url: target,
          headers: { ...clientHeaders, "idempotency-key": key },
          payload: {},
        });
      const cap = await app.inject({
        method: "GET",
        url: cancellationRoot + "/capability",
        headers: clientHeaders,
      });
      assert.deepEqual(cap.json(), { cutoffMinutes: 60 });
      const noCancel = await disabled.inject({
        method: "POST",
        url: cancelUrl,
        headers: clientHeaders,
        payload: {},
      });
      assert.equal(noCancel.statusCode, 404);
      const ownerCancel = await app.inject({
        method: "POST",
        url: cancelUrl,
        headers: { ...headers, "idempotency-key": cancelKey },
        payload: {},
      });
      assert.equal(ownerCancel.statusCode, 404);
      const unauthorizedCancel = await app.inject({
        method: "POST",
        url: cancelUrl,
        payload: {},
      });
      assert.equal(unauthorizedCancel.statusCode, 401);
      const foreignCancel = await cancel(
        randomUUID(),
        cancelUrl.replace(owner.tenantId, randomUUID()),
      );
      assert.equal(foreignCancel.statusCode, 403);
      const another = await pool.query<{ id: string }>(
        "SELECT id::text FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND customer_id=$2::uuid",
        [owner.tenantId, customer],
      );
      const otherCancel = await cancel(
        randomUUID(),
        cancellationRoot + "/" + another.rows[0]!.id,
      );
      assert.equal(otherCancel.statusCode, 404);
      const cutoffFailure = await cutoffDenied.inject({
        method: "POST",
        url: cancelUrl,
        headers: { ...clientHeaders, "idempotency-key": cancelKey },
        payload: {},
      });
      assert.equal(cutoffFailure.statusCode, 409);
      assert.equal(cutoffFailure.json().error, "CANCELLATION_POLICY_DENIED");
      assert.deepEqual((await history()).json(), ownHistory.json());
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'staging.customer.booking.cancel') WHERE tenant_id=$1::uuid AND base_type='client'",
        [owner.tenantId],
      );
      const forbiddenCancel = await cancel();
      assert.equal(forbiddenCancel.statusCode, 403);
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_append(permissions,'staging.customer.booking.cancel') WHERE tenant_id=$1::uuid AND base_type='client'",
        [owner.tenantId],
      );
      const [cancelled, replayedCancel] = await Promise.all([
        cancel(),
        cancel(),
      ]);
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      assert.deepEqual(replayedCancel.json(), cancelled.json());
      assert.equal(cancelled.json().status, "CancelledByClient");
      assert.equal(cancelled.json().bookingId, created.json().bookingId);
      const newCancelKey = await cancel(randomUUID());
      assert.equal(newCancelKey.statusCode, 409);
      const freed = (await clientSlots()).json().slots as Array<{
        startAt: string;
      }>;
      assert.ok(freed.some((slot) => slot.startAt === bookingPayload.startAt));
      const cancellationAudit = await pool.query(
        "SELECT previous_status,next_status FROM cookie_booking.booking_state_audit WHERE tenant_id=$1::uuid AND booking_id=$2::uuid",
        [owner.tenantId, created.json().bookingId],
      );
      assert.deepEqual(cancellationAudit.rows, [
        { previous_status: "Confirmed", next_status: "CancelledByClient" },
      ]);
      const cancelledHistory = await history();
      assert.deepEqual(cancelledHistory.json().bookings, [
        { ...ownHistory.json().bookings[0], status: "CancelledByClient" },
      ]);
      const rebooked = await book(randomUUID());
      assert.equal(rebooked.statusCode, 201);
      assert.notEqual(rebooked.json().bookingId, created.json().bookingId);
      const beforeExpiry = await history();
      await pool.query(
        "UPDATE cookie_entitlement.staging_publication_grants SET issued_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1::uuid",
        [owner.tenantId],
      );
      assert.equal((await submit()).json().error, "grant-unavailable");
      assert.equal((await preview()).statusCode, 409);
      assert.deepEqual((await clientOffers()).json(), { offers: [] });
      assert.equal((await clientSlots()).statusCode, 409);
      assert.deepEqual((await recover()).json(), created.json());
      const expiredBooking = await book(randomUUID());
      assert.equal(expiredBooking.json().error, "grant-unavailable");
      assert.deepEqual((await history()).json(), beforeExpiry.json());
      await revokeStagingGrant(pool, owner.tenantId);
      // Existing bookings stay manageable even after the publication grant
      // expires; a customer time-only move never creates a new booking.
      const moveRoot = prefix + "/staging-customer-reschedule";
      const movedBookingId: string = rebooked.json().bookingId;
      const moveTarget = afterRace.find(s => s.startAt !== bookingPayload.startAt)?.startAt;
      assert.ok(moveTarget, "Expected another server-available start for the same shift");
      const moveUrl = moveRoot + "/" + movedBookingId;
      const moveKey = randomUUID();
      const move = (key = moveKey, newStartAt = moveTarget!, target = moveUrl) =>
        app.inject({
          method: "POST", url: target,
          headers: { ...clientHeaders, "idempotency-key": key },
          payload: { newStartAt },
        });
      assert.deepEqual((await app.inject({
        method: "GET", url: moveRoot + "/capability", headers: clientHeaders,
      })).json(), { cutoffMinutes: 30 });
      assert.equal((await disabled.inject({ method: "POST", url: moveUrl,
        headers: { ...clientHeaders, "idempotency-key": moveKey },
        payload: { newStartAt: moveTarget } })).statusCode, 404);
      assert.equal((await app.inject({ method: "POST", url: moveUrl,
        payload: { newStartAt: moveTarget } })).statusCode, 401);
      assert.equal((await move(randomUUID(), moveTarget, moveUrl.replace(owner.tenantId, randomUUID()))).statusCode, 403);
      assert.equal((await move(randomUUID(), moveTarget, moveRoot + "/" + another.rows[0]!.id)).statusCode, 404);
      const deniedMove = await cutoffDenied.inject({
        method: "POST", url: moveUrl,
        headers: { ...clientHeaders, "idempotency-key": moveKey },
        payload: { newStartAt: moveTarget },
      });
      assert.equal(deniedMove.statusCode, 409);
      assert.equal(deniedMove.json().error, "RESCHEDULE_POLICY_DENIED");
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'staging.customer.booking.reschedule') WHERE tenant_id=$1::uuid AND base_type='client'",
        [owner.tenantId],
      );
      assert.equal((await move()).statusCode, 403);
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_append(permissions,'staging.customer.booking.reschedule') WHERE tenant_id=$1::uuid AND base_type='client'",
        [owner.tenantId],
      );
      const [moved, sameKeyMove] = await Promise.all([move(), move()]);
      assert.equal(moved.statusCode, 200, moved.body);
      assert.deepEqual(sameKeyMove.json(), moved.json());
      assert.equal(moved.json().bookingId, movedBookingId);
      assert.equal(moved.json().status, "Confirmed");
      assert.equal(moved.json().startAt, moveTarget);
      assert.equal(moved.json().previousStartAt, bookingPayload.startAt);
      assert.equal(moved.json().priceKopecks, rebooked.json().priceKopecks);
      assert.equal((await move(moveKey, slots[10]!.startAt)).statusCode, 409);
      const stateAfterMove = await pool.query(
        "SELECT start_at,price_kopecks_snapshot::text AS price,service_id::text AS service,staff_id::text AS staff,location_id::text AS location FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [owner.tenantId, movedBookingId],
      );
      assert.equal(stateAfterMove.rows[0].start_at.toISOString(), moveTarget);
      assert.equal(stateAfterMove.rows[0].price, "100000");
      assert.equal(stateAfterMove.rows[0].service, serviceId);
      assert.equal(stateAfterMove.rows[0].staff, staffId);
      assert.equal(stateAfterMove.rows[0].location, owner.locationId);
      const moveSideEffects = await pool.query(
        "SELECT (SELECT count(*)::int FROM cookie_booking.time_change_audit WHERE tenant_id=$1::uuid AND booking_id=$2::uuid) AS audits, (SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1::uuid AND booking_id=$2::uuid AND operation='booking.reschedule') AS receipts, (SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic='booking.rescheduled' AND payload->>'bookingId'=$2) AS events",
        [owner.tenantId, movedBookingId],
      );
      assert.deepEqual(moveSideEffects.rows[0], { audits: 1, receipts: 1, events: 1 });
      const afterGrant = await cancel(
        randomUUID(),
        cancellationRoot + "/" + rebooked.json().bookingId,
      );
      assert.equal(afterGrant.statusCode, 200);
      assert.equal(afterGrant.json().status, "CancelledByClient");
      const finalCounts = await pool.query(
        "SELECT (SELECT count(*)::int FROM cookie_booking.booking_state_audit WHERE tenant_id=$1::uuid) AS audits,(SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1::uuid AND operation='booking.cancel') AS receipts,(SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic='booking.cancelled') AS events",
        [owner.tenantId],
      );
      assert.deepEqual(finalCounts.rows[0], {
        audits: 2,
        receipts: 2,
        events: 2,
      });
      assert.deepEqual((await clientOffers()).json(), { offers: [] });
      await app.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers: clientHeaders,
      });
      assert.equal((await history()).statusCode, 401);
      assert.equal((await recover()).statusCode, 401);
      const revokedReplay = await cancel();
      assert.equal(revokedReplay.statusCode, 401);
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
        await cutoffDenied.close();
        await app.close();
        if (tenantId) {
          await pool.query(
            "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic IN ('schedule.shift.draft.created','schedule.shift.published','booking.confirmed','booking.cancelled','booking.rescheduled')",
            [tenantId],
          );
        }
      } finally {
        await pool.end();
      }
    }
  },
);
