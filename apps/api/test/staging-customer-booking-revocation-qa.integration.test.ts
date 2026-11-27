import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
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

const BOT = "123456789:synthetic_booking_race_not_real";
const APP = "cookie-staging-booking-revocation-qa";

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

type Sql = { readonly text: string; readonly values: readonly string[] };

/** A real row lock, not a sleep or a simulated authorization provider.
 * Wait for pg_blocking_pids to prove that the HTTP command reached this
 * specific checkpoint, and release the barrier even on test failure.
 */
async function atBarrier<T>(
  pool: Pool,
  lock: Sql,
  command: () => Promise<T>,
  inspect: () => Promise<void>,
): Promise<T> {
  const holder = await pool.connect();
  let pending: Promise<T> | undefined;
  try {
    await holder.query("BEGIN");
    const pid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    assert.equal((await holder.query(lock.text, [...lock.values])).rowCount, 1);
    pending = command();
    // Attach a rejection handler before inspecting the independent DB state.
    void pending.catch(() => undefined);
    const deadline = Date.now() + 8000;
    let blocked = false;
    while (Date.now() < deadline) {
      const observation = await pool.query<{ blocked: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$2 AND pid<>$1::int AND $1::int=ANY(pg_blocking_pids(pid))) AS blocked",
        [pid, APP],
      );
      if (observation.rows[0]?.blocked) {
        blocked = true;
        break;
      }
      await pause(20);
    }
    assert.equal(
      blocked,
      true,
      "Booking never reached the real row-lock checkpoint",
    );
    await inspect();
  } finally {
    try {
      await holder.query("ROLLBACK");
    } finally {
      holder.release();
      // Drain the in-flight HTTP request on both success and assertion failure.
      await pending?.catch(() => undefined);
    }
  }
  assert.ok(pending);
  return pending;
}

async function revokeMustWait(pool: Pool, change: Sql): Promise<void> {
  const other = await pool.connect();
  try {
    await other.query("BEGIN");
    await other.query("SET LOCAL lock_timeout = '500ms'");
    await assert.rejects(
      other.query(change.text, [...change.values]),
      (error: unknown) => (error as { code?: string }).code === "55P03",
      "Revocation must wait behind the original authorized Booking",
    );
  } finally {
    try {
      await other.query("ROLLBACK");
    } finally {
      other.release();
    }
  }
}

async function durable(pool: Pool, tenantId: string) {
  const result = await pool.query<{
    bookings: number;
    receipts: number;
    events: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM cookie_booking.bookings WHERE tenant_id=$1::uuid) AS bookings,
       (SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1::uuid) AS receipts,
       (SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic='booking.confirmed') AS events`,
    [tenantId],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}

test(
  "staging customer Booking serializes exact permission, membership, bearer, link and grant revocation in both orders",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: APP,
      max: 10,
    });
    const secret = randomBytes(32);
    const verifier = createTelegramMiniAppProofVerifier({
      botToken: BOT,
      maxAgeSeconds: 300,
    });
    const sessions = new PostgresOpaqueTelegramSessions({
      pool,
      fingerprintSecret: secret,
      telegramProofVerifier: verifier,
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
        organizationName: "Synthetic race studio",
        locationName: "Synthetic UTC branch",
        timeZone: "UTC",
        idempotencyKey: randomUUID(),
      });
      tenantId = owner.tenantId;
      const tenant = owner.tenantId;
      const prefix = "/v1/organizations/" + tenant;
      const signed = proof(19191001);
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
        displayName: "Synthetic race service",
        durationMinutes: 60,
        basePriceKopecks: 100000,
      });
      assert.equal(service.statusCode, 201);
      const serviceId: string = service.json().service.id;
      const staff = await post("/staff", ownerToken, {
        displayName: "Synthetic race staff",
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

      async function customer(userId: number) {
        const rawInitData = proof(userId);
        const context = await provisionStagingCustomer(pool, verifier, secret, {
          tenantId: tenant,
          rawInitData,
          consentConfirmed: true,
        });
        const token = await login(rawInitData);
        const binding = await pool.query<{
          identity_id: string;
          telegram_link_id: string;
          role_id: string;
          assignment_id: string;
        }>(
          `SELECT c.identity_id::text,c.telegram_link_id::text,
                  a.role_id::text,a.id::text AS assignment_id
             FROM cookie_customers.staging_customer_identities c
             JOIN cookie_identity.role_assignments a
               ON a.tenant_id=c.tenant_id AND a.identity_id=c.identity_id
            WHERE c.tenant_id=$1::uuid AND c.customer_id=$2::uuid`,
          [tenant, context.customerId],
        );
        assert.equal(binding.rowCount, 1);
        const b = binding.rows[0]!;
        const role: Sql = {
          text: "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'staging.customer.booking.create') WHERE tenant_id=$1::uuid AND id=$2::uuid",
          values: [tenant, b.role_id],
        };
        const assignment: Sql = {
          text: "UPDATE cookie_identity.role_assignments SET active=false WHERE tenant_id=$1::uuid AND id=$2::uuid",
          values: [tenant, b.assignment_id],
        };
        const membership: Sql = {
          text: "UPDATE cookie_identity.memberships SET active=false WHERE tenant_id=$1::uuid AND identity_id=$2::uuid",
          values: [tenant, b.identity_id],
        };
        const bearer: Sql = {
          text: "UPDATE cookie_identity.opaque_sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1::uuid AND token_sha256=decode($2::text,'hex')",
          values: [tenant, createHash("sha256").update(token).digest("hex")],
        };
        const link: Sql = {
          text: "UPDATE cookie_identity.telegram_identity_links SET revoked_at=clock_timestamp() WHERE tenant_id=$1::uuid AND id=$2::uuid",
          values: [tenant, b.telegram_link_id],
        };
        return { context, token, role, assignment, membership, bearer, link };
      }
      const grant: Sql = {
        text: "UPDATE cookie_entitlement.staging_publication_grants SET revoked_at=clock_timestamp() WHERE tenant_id=$1::uuid",
        values: [tenant],
      };
      const staffBarrier: Sql = {
        text: "SELECT id FROM cookie_staff.staff_profiles WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE",
        values: [tenant, staffId],
      };
      const serviceBarrier: Sql = {
        text: "SELECT id FROM cookie_catalog.services WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE",
        values: [tenant, serviceId],
      };
      const request = (token: string, startAt: string, key: string) =>
        post(
          "/staging-customer-bookings",
          token,
          {
            locationId: owner.locationId,
            staffId,
            serviceId,
            startAt,
          },
          key,
        );
      const empty = { bookings: 0, receipts: 0, events: 0 };
      assert.deepEqual(await durable(pool, tenant), empty);

      // The request reached Staff FOR UPDATE after actual HTTP preflight,
      // but cannot take its policy/session/grant locks yet.
      for (const [index, kind] of (
        ["role", "assignment", "membership", "bearer", "link"] as const
      ).entries()) {
        const client = await customer(19191010 + index);
        const denied = await atBarrier(
          pool,
          staffBarrier,
          async () =>
            request(client.token, date + "T11:00:00.000Z", randomUUID()),
          async () => {
            const change = client[kind];
            assert.equal(
              (await pool.query(change.text, [...change.values])).rowCount,
              1,
            );
            assert.deepEqual(await durable(pool, tenant), empty);
          },
        );
        assert.ok(
          [401, 403].includes(denied.statusCode),
          "Revoke-first " + kind + " returned " + denied.statusCode,
        );
        assert.deepEqual(await durable(pool, tenant), empty);
      }

      // Service row is read AFTER Staff, policy, exact link/session and live
      // grant. The command must retain every authority lock through COMMIT.
      const good = await customer(19191030);
      const key = randomUUID();
      const start = date + "T09:00:00.000Z";
      const successful = await atBarrier(
        pool,
        serviceBarrier,
        async () => request(good.token, start, key),
        async () => {
          for (const change of [
            good.role,
            good.assignment,
            good.membership,
            good.bearer,
            good.link,
            grant,
          ]) {
            await revokeMustWait(pool, change);
          }
          assert.deepEqual(await durable(pool, tenant), empty);
        },
      );
      assert.equal(successful.statusCode, 201);
      assert.equal(successful.json().status, "Confirmed");
      assert.equal(successful.json().startAt, start);
      const persisted = await pool.query(
        "SELECT customer_id::text,status,price_kopecks_snapshot::text FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [tenant, successful.json().bookingId],
      );
      assert.deepEqual(persisted.rows, [
        {
          customer_id: good.context.customerId,
          status: "Confirmed",
          price_kopecks_snapshot: "100000",
        },
      ]);
      const one = { bookings: 1, receipts: 1, events: 1 };
      assert.deepEqual(await durable(pool, tenant), one);
      const replay = await request(good.token, start, key);
      assert.equal(replay.statusCode, 201);
      assert.deepEqual(replay.json(), successful.json());

      // Grant revoked before a *new* command resumes. Existing exact receipt
      // remains recoverable while the exact Customer authorization is valid.
      const last = await customer(19191031);
      assert.notEqual(last.context.customerId, good.context.customerId);
      const getReceipt = (token: string, receiptKey: string) =>
        app.inject({
          method: "GET",
          url: prefix + "/staging-customer-bookings/receipt",
          headers: {
            authorization: "Bearer " + token,
            "idempotency-key": receiptKey,
          },
        });
      const ownReceipt = await getReceipt(good.token, key);
      assert.equal(ownReceipt.statusCode, 200);
      assert.deepEqual(ownReceipt.json(), successful.json());
      assert.equal(ownReceipt.headers["cache-control"], "no-store");

      // This independently verified Customer belongs to the SAME tenant.
      // Knowing the winning raw key must not distinguish its receipt from
      // an unknown key or expose any booking ID, time or price.
      const foreignReceipt = await getReceipt(last.token, key);
      const unknownReceipt = await getReceipt(last.token, randomUUID());
      for (const response of [foreignReceipt, unknownReceipt]) {
        assert.equal(response.statusCode, 404);
        assert.deepEqual(response.json(), { error: "receipt-unavailable" });
        assert.equal(response.headers["cache-control"], "no-store");
        assert.equal(response.headers.vary, "Authorization, Idempotency-Key");
      }
      assert.deepEqual(foreignReceipt.json(), unknownReceipt.json());
      assert.deepEqual(await durable(pool, tenant), one);

      const revoked = await atBarrier(
        pool,
        staffBarrier,
        async () => request(last.token, date + "T13:00:00.000Z", randomUUID()),
        async () => {
          await revokeStagingGrant(pool, tenant);
          assert.deepEqual(await durable(pool, tenant), one);
        },
      );
      assert.equal(revoked.statusCode, 409);
      assert.equal(revoked.json().error, "grant-unavailable");
      const recover = await request(good.token, start, key);
      assert.equal(recover.statusCode, 201);
      assert.deepEqual(recover.json(), successful.json());
      const recoveredRead = await getReceipt(good.token, key);
      assert.equal(recoveredRead.statusCode, 200);
      assert.deepEqual(recoveredRead.json(), successful.json());
      const foreignAfterGrant = await getReceipt(last.token, key);
      assert.equal(foreignAfterGrant.statusCode, 404);
      assert.deepEqual(foreignAfterGrant.json(), {
        error: "receipt-unavailable",
      });
      // #23: a customer time-only move is legal even after the publication
      // grant has expired. The exact customer session, Customer relation and
      // reschedule permission must still be checked on the mutation.
      const originalBookingId: string = successful.json().bookingId;
      const moveStart = date + "T11:00:00.000Z";
      const moveUrl = "/staging-customer-reschedule/" + originalBookingId;
      const move = (token: string, moveKey: string, newStartAt = moveStart) =>
        post(moveUrl, token, { newStartAt }, moveKey);
      const moveRole: Sql = {
        text: "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'staging.customer.booking.reschedule') WHERE tenant_id=$1::uuid AND id=$2::uuid",
        values: good.role.values,
      };
      const deniedKey = randomUUID();

      // Revoke-first: the HTTP move reaches the staff lock, then a different
      // PostgreSQL transaction removes the exact grant and commits first.
      // The reschedule must reject rather than commit using stale preflight.
      const moveDenied = await atBarrier(
        pool,
        staffBarrier,
        () => move(good.token, deniedKey),
        async () => {
          assert.equal(
            (await pool.query(moveRole.text, [...moveRole.values])).rowCount,
            1,
          );
        },
      );
      assert.equal(moveDenied.statusCode, 403, moveDenied.body);
      assert.deepEqual(await durable(pool, tenant), one);
      const afterDenied = await pool.query<{ start_at: Date }>(
        "SELECT start_at FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [tenant, originalBookingId],
      );
      assert.equal(afterDenied.rows[0]?.start_at.toISOString(), start);
      // Restore the synthetic customer permission to test the opposite order.
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_append(permissions,'staging.customer.booking.reschedule') WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [...moveRole.values],
      );

      // Commit-first: reschedule already holds authorization/session locks
      // while a real service FOR SHARE read waits for this test's FOR UPDATE.
      // Each concurrent revocation must block until Booking commits.
      const moveKey = randomUUID();
      const moved = await atBarrier(
        pool,
        serviceBarrier,
        () => move(good.token, moveKey),
        async () => {
          for (const change of [
            moveRole,
            good.assignment,
            good.membership,
            good.bearer,
            good.link,
          ]) {
            await revokeMustWait(pool, change);
          }
          assert.deepEqual(await durable(pool, tenant), one);
        },
      );
      assert.equal(moved.statusCode, 200, moved.body);
      assert.equal(moved.json().bookingId, originalBookingId);
      assert.equal(moved.json().previousStartAt, start);
      assert.equal(moved.json().startAt, moveStart);
      assert.equal(moved.json().status, "Confirmed");
      assert.equal(moved.json().priceKopecks, successful.json().priceKopecks);
      const sameKeyMove = await move(good.token, moveKey);
      assert.equal(sameKeyMove.statusCode, 200);
      assert.deepEqual(sameKeyMove.json(), moved.json());
      const changedReplay = await move(
        good.token,
        moveKey,
        date + "T12:00:00.000Z",
      );
      assert.equal(changedReplay.statusCode, 409);
      assert.equal(changedReplay.json().error, "IDEMPOTENCY_KEY_REUSED");
      const movedState = await pool.query<{
        start_at: Date;
        price: string;
        status: string;
        customer_id: string;
      }>(
        "SELECT start_at,price_kopecks_snapshot::text AS price,status,customer_id::text FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [tenant, originalBookingId],
      );
      assert.equal(movedState.rows[0]?.start_at.toISOString(), moveStart);
      assert.equal(movedState.rows[0]?.status, "Confirmed");
      assert.equal(movedState.rows[0]?.customer_id, good.context.customerId);
      assert.equal(movedState.rows[0]?.price, "100000");
      const effects = await pool.query<{
        audits: number;
        receipts: number;
        events: number;
      }>(
        `SELECT
          (SELECT count(*)::int FROM cookie_booking.time_change_audit
             WHERE tenant_id=$1::uuid AND booking_id=$2::uuid) AS audits,
          (SELECT count(*)::int FROM cookie_booking.command_receipts
             WHERE tenant_id=$1::uuid AND booking_id=$2::uuid
               AND operation='booking.reschedule') AS receipts,
          (SELECT count(*)::int FROM cookie_jobs.outbox_events
             WHERE tenant_id=$1::uuid AND topic='booking.rescheduled'
               AND payload->>'bookingId'=$2::text) AS events`,
        [tenant, originalBookingId],
      );
      assert.deepEqual(effects.rows[0], {
        audits: 1,
        receipts: 1,
        events: 1,
      });
      assert.deepEqual(await durable(pool, tenant), {
        bookings: 1,
        receipts: 2,
        events: 1,
      });

      assert.equal(await sessions.revokeBearerToken(good.token), true);
      const revokedRead = await getReceipt(good.token, key);
      assert.ok([401, 403].includes(revokedRead.statusCode));
      assert.deepEqual(Object.keys(revokedRead.json()), ["error"]);
      assert.equal(revokedRead.headers["cache-control"], "no-store");
      assert.ok(
        [401, 403].includes((await request(good.token, start, key)).statusCode),
      );
      assert.ok(
        [401, 403].includes((await move(good.token, moveKey)).statusCode),
        "Revoked bearer must not replay a previously committed move",
      );
      assert.deepEqual(await durable(pool, tenant), {
        bookings: 1,
        receipts: 2,
        events: 1,
      });
    } finally {
      try {
        await app.close();
        if (tenantId) {
          // Only this isolated synthetic tenant; don't contaminate later
          // worker tests with our deliberate confirmed/create events.
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
