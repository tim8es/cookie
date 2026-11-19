import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createApp } from "../src/app.js";
import { createBookingInternal } from "../../../packages/domain-booking/src/index.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { linkVerifiedTelegramOwner } from "../../../packages/platform-identity/src/link-telegram-owner.js";
import { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";
import { provisionOwnerWorkspace } from "../../../packages/platform-identity/src/provision-owner-workspace.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import { createPostgresVerifiedTelegramLinkResolver } from "../../../packages/platform-identity/src/telegram-links.js";

const BOT = "123456789:synthetic_buffer_not_real_bot";
const SECRET = Buffer.alloc(32, 0x7b);

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
  "owner service buffer is tenant scoped, revisioned and replay safe",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-owner-buffer-e2e",
      max: 6,
    });
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
    });
    let bookingTenant: string | undefined;
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      async function setup(userId: number) {
        const ownerId = randomUUID();
        await pool.query(
          "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
          [ownerId],
        );
        const owner = await provisionOwnerWorkspace(pool, {
          ownerIdentityId: ownerId,
          organizationName: "Synthetic buffer salon",
          locationName: "Central",
          timeZone: "UTC",
          idempotencyKey: "buffer-setup-" + randomUUID(),
        });
        const signed = proof(userId);
        await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
          tenantId: owner.tenantId,
          ownerIdentityId: ownerId,
          rawInitData: signed,
          consentConfirmed: true,
        });
        const exchanged = await app.inject({
          method: "POST",
          url: "/v1/auth/telegram/exchange",
          payload: { initData: signed },
        });
        assert.equal(exchanged.statusCode, 201);
        return {
          tenantId: owner.tenantId,
          locationId: owner.locationId,
          ownerId,
          url: "/v1/organizations/" + owner.tenantId + "/services",
          headers: { authorization: "Bearer " + exchanged.json().accessToken },
        };
      }
      const a = await setup(19190033);
      const b = await setup(19190034);
      const key = randomUUID();
      const base = {
        displayName: "Synthetic haircut",
        durationMinutes: 45,
        basePriceKopecks: 150000,
      };
      const submit = (scope: typeof a, payload: object, requestKey = key) =>
        app.inject({
          method: "POST",
          url: scope.url,
          headers: { ...scope.headers, "idempotency-key": requestKey },
          payload,
        });
      const list = (scope: typeof a) =>
        app.inject({ method: "GET", url: scope.url, headers: scope.headers });
      const first = await submit(a, { ...base, postServiceBufferMinutes: 15 });
      const second = await submit(b, { ...base, postServiceBufferMinutes: 45 });
      assert.equal(first.statusCode, 201);
      assert.equal(second.statusCode, 201);
      const service = first.json().service;
      const other = second.json().service;
      assert.equal(service.postServiceBufferMinutes, 15);
      assert.equal(other.postServiceBufferMinutes, 45);
      assert.deepEqual((await list(a)).json().services, [service]);
      assert.deepEqual((await list(b)).json().services, [other]);
      const changedCreate = await submit(a, {
        ...base,
        postServiceBufferMinutes: 0,
      });
      assert.equal(changedCreate.statusCode, 409);
      assert.equal((await submit(a, base)).statusCode, 409);
      const replay = await submit(a, { ...base, postServiceBufferMinutes: 15 });
      assert.equal(replay.statusCode, 200);
      assert.deepEqual(replay.json().service, service);

      const edit = (
        payload: object,
        editKey = randomUUID(),
        scope = a,
        id: string = service.id,
      ) =>
        app.inject({
          method: "PATCH",
          url: scope.url + "/" + id,
          headers: { ...scope.headers, "idempotency-key": editKey },
          payload,
        });
      for (const value of [-1, 1441, 0.5, null, "15"]) {
        const invalidCreate = await submit(
          a,
          { ...base, postServiceBufferMinutes: value },
          randomUUID(),
        );
        assert.equal(invalidCreate.statusCode, 400);
        const invalidEdit = await edit({
          ...base,
          expectedRevision: 0,
          postServiceBufferMinutes: value,
        });
        assert.equal(invalidEdit.statusCode, 400);
      }
      const foreignEdit = await edit(
        { ...base, expectedRevision: 0, postServiceBufferMinutes: 0 },
        randomUUID(),
        b,
      );
      assert.equal(foreignEdit.statusCode, 404);
      // Old clients cannot accidentally erase a configured buffer.
      const legacyEdit = { ...base, expectedRevision: 0 };
      const legacyEditKey = randomUUID();
      const preserved = await edit(legacyEdit, legacyEditKey);
      assert.equal(preserved.statusCode, 200);
      assert.equal(preserved.json().service.postServiceBufferMinutes, 15);
      // Simulate an immutable pre-upgrade receipt without the newly exposed
      // field, never reconstruct it from later current state.
      const legacyEditHash = createHash("sha256")
        .update(
          JSON.stringify([
            1,
            service.id,
            legacyEdit.expectedRevision,
            base.displayName,
            base.durationMinutes,
            base.basePriceKopecks,
          ]),
        )
        .digest("hex");
      const oldEditRow = await pool.query(
        `SELECT request_sha256 FROM cookie_catalog.service_edit_receipts
          WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid AND idempotency_key=$3`,
        [a.tenantId, a.ownerId, legacyEditKey],
      );
      assert.deepEqual(oldEditRow.rows, [{ request_sha256: legacyEditHash }]);
      await pool.query(
        `UPDATE cookie_catalog.service_edit_receipts
          SET result_service=result_service-'postServiceBufferMinutes'
          WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid AND idempotency_key=$3`,
        [a.tenantId, a.ownerId, legacyEditKey],
      );
      const explicit = {
        ...base,
        expectedRevision: 1,
        postServiceBufferMinutes: 0,
      };
      const explicitKey = randomUUID();
      const cleared = await edit(explicit, explicitKey);
      assert.equal(cleared.statusCode, 200);
      assert.equal(cleared.json().service.postServiceBufferMinutes, 0);
      assert.equal(cleared.json().service.revision, 2);
      assert.equal((await edit(explicit)).statusCode, 409);
      const changedEdit = await edit(
        { ...explicit, postServiceBufferMinutes: 1 },
        explicitKey,
      );
      assert.equal(changedEdit.statusCode, 409);
      const editedReplay = await edit(explicit, explicitKey);
      assert.deepEqual(editedReplay.json(), cleared.json());
      const legacy = await edit(legacyEdit, legacyEditKey);
      assert.equal(legacy.statusCode, 200);
      assert.equal(
        Object.hasOwn(legacy.json().service, "postServiceBufferMinutes"),
        false,
      );
      const current = await list(a);
      assert.deepEqual(current.json().services, [cleared.json().service]);
      assert.deepEqual((await list(b)).json().services, [other]);
      const stored = await pool.query(
        `SELECT post_service_buffer_minutes,draft_revision
          FROM cookie_catalog.services WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [a.tenantId, service.id],
      );
      assert.deepEqual(stored.rows, [
        { post_service_buffer_minutes: 0, draft_revision: 2 },
      ]);
      // Historical v1 create hashes and receipt bytes must also survive.
      const oldKey = randomUUID();
      const old = await submit(a, base, oldKey);
      assert.equal(old.statusCode, 201);
      assert.equal(old.json().service.postServiceBufferMinutes, 0);
      const legacyCreateHash = createHash("sha256")
        .update(
          JSON.stringify([
            1,
            base.displayName,
            base.durationMinutes,
            base.basePriceKopecks,
          ]),
        )
        .digest("hex");
      const oldCreateRow = await pool.query(
        `SELECT request_sha256 FROM cookie_catalog.service_create_receipts
          WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid AND idempotency_key=$3`,
        [a.tenantId, a.ownerId, oldKey],
      );
      const legacyCreateRecord = { request_sha256: legacyCreateHash };
      assert.deepEqual(oldCreateRow.rows, [legacyCreateRecord]);
      await pool.query(
        `UPDATE cookie_catalog.service_create_receipts
          SET result_service=result_service-'postServiceBufferMinutes'
          WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid AND idempotency_key=$3`,
        [a.tenantId, a.ownerId, oldKey],
      );
      const oldReplay = await submit(a, base, oldKey);
      assert.equal(oldReplay.statusCode, 200);
      assert.equal(oldReplay.json().service.id, old.json().service.id);
      assert.equal(
        Object.hasOwn(oldReplay.json().service, "postServiceBufferMinutes"),
        false,
      );
      const changedLegacyCreate = await submit(
        a,
        { ...base, postServiceBufferMinutes: 0 },
        oldKey,
      );
      assert.equal(changedLegacyCreate.statusCode, 409);

      // Trusted internal fixture activation does not change the saved buffer.
      // Use the real API-created service from the second tenant; do not
      // seed a separate service or overwrite its duration/buffer.
      const staff = randomUUID();
      const customer = randomUUID();
      const tenant = b.tenantId;
      bookingTenant = tenant;
      const location = b.locationId;
      await pool.query(
        "UPDATE cookie_catalog.services SET active=true WHERE tenant_id=$1 AND id=$2",
        [tenant, other.id],
      );
      await pool.query(
        `INSERT INTO cookie_customers.customers(tenant_id,id)
          VALUES($1,$2)`,
        [tenant, customer],
      );
      await pool.query(
        `INSERT INTO cookie_staff.staff_profiles
          (tenant_id,id,display_name,active,bookable)
          VALUES($1,$2,'Synthetic buffer staff',true,true)`,
        [tenant, staff],
      );
      await pool.query(
        `INSERT INTO cookie_staff.location_assignments
          (tenant_id,staff_id,location_id,active) VALUES($1,$2,$3,true)`,
        [tenant, staff, location],
      );
      await pool.query(
        `INSERT INTO cookie_staff.service_assignments
          (tenant_id,staff_id,location_id,service_id,active)
          VALUES($1,$2,$3,$4,true)`,
        [tenant, staff, location, other.id],
      );
      await pool.query(
        `INSERT INTO cookie_scheduling.shift_windows
          (tenant_id,id,staff_id,location_id,start_at,end_at,active)
          VALUES($1,$2,$3,$4,'2028-04-12T09:00:00Z',
                 '2028-04-12T18:00:00Z',true)`,
        [tenant, randomUUID(), staff, location],
      );
      const command = {
        actor: {
          identityId: b.ownerId,
          tenantId: tenant,
          correlationId: "synthetic-catalog-buffer-booking",
        },
        customerId: customer,
        staffId: staff,
        serviceId: other.id,
        locationId: location,
        startAt: "2028-04-12T10:00:00Z",
        idempotencyKey: randomUUID(),
      };
      const allow = async () => undefined;
      const booking = await createBookingInternal(pool, command, allow);
      assert.equal(booking.endAt, "2028-04-12T10:45:00.000Z");
      assert.equal(booking.occupiedUntil, "2028-04-12T11:30:00.000Z");
      const bookingReplay = await createBookingInternal(pool, command, allow);
      assert.deepEqual(bookingReplay, booking);
      await assert.rejects(
        createBookingInternal(
          pool,
          {
            ...command,
            startAt: "2028-04-12T10:45:00Z",
            idempotencyKey: randomUUID(),
          },
          allow,
        ),
        { code: "BOOKING_NOT_AVAILABLE" },
      );
      const boundary = await createBookingInternal(
        pool,
        {
          ...command,
          startAt: "2028-04-12T11:30:00Z",
          idempotencyKey: randomUUID(),
        },
        allow,
      );
      assert.equal(boundary.endAt, "2028-04-12T12:15:00.000Z");
      assert.equal(boundary.occupiedUntil, "2028-04-12T13:00:00.000Z");
      const snapshots = await pool.query(
        `SELECT service_duration_minutes_snapshot,
                post_service_buffer_minutes_snapshot
           FROM cookie_booking.bookings WHERE tenant_id=$1
           ORDER BY start_at`,
        [tenant],
      );
      const expectedSnapshot = {
        service_duration_minutes_snapshot: 45,
        post_service_buffer_minutes_snapshot: 45,
      };
      assert.deepEqual(snapshots.rows, [expectedSnapshot, expectedSnapshot]);
    } finally {
      // The integration suite shares a database with the global Worker
      // test. Remove only events from this test's generated booking tenant.
      try {
        if (bookingTenant) {
          await pool.query(
            "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id=$1",
            [bookingTenant],
          );
        }
      } finally {
        try {
          await app.close();
        } finally {
          await pool.end();
        }
      }
    }
  },
);
