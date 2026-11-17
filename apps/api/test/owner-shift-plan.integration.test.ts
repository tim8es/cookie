import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
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
  "real owner plans a future shift for unpublished Staff without publishing availability",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-owner-shift-plan-e2e",
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
      shiftPlanRoutes: { pool, verifier: sessions },
    });
    const disabled = createApp(pool);
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query("INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)", [ownerId]);
      const owner = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: ownerId,
        organizationName: "Synthetic shift studio",
        locationName: "Synthetic branch",
        timeZone: "Europe/Moscow",
        idempotencyKey: randomUUID(),
      });

      const signed = proof(19190009);
      await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: owner.tenantId,
        ownerIdentityId: ownerId,
        rawInitData: signed,
        consentConfirmed: true,
      });
      const prefix = "/v1/organizations/" + owner.tenantId;
      const url = prefix + "/shift-plans";
      assert.equal((await disabled.inject({ method: "GET", url })).statusCode, 404);
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
      const exchange = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: signed },
      });
      assert.equal(exchange.statusCode, 201);
      const headers = { authorization: "Bearer " + exchange.json().accessToken };
      const empty = await app.inject({ method: "GET", url, headers });
      assert.equal(empty.statusCode, 200);
      assert.equal(empty.headers["cache-control"], "no-store");
      assert.deepEqual(empty.json(), { plans: [], hasMore: false });
      const foreign = await app.inject({
        method: "GET", url: "/v1/organizations/" + randomUUID() + "/shift-plans", headers,
      });
      assert.equal(foreign.statusCode, 403);

      const service = await app.inject({
        method: "POST",
        url: prefix + "/services",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { displayName: "Synthetic service", durationMinutes: 60, basePriceKopecks: 100000 },
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
      const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const draft = {
        staffId,
        locationId: owner.locationId,
        startLocal: date + "T09:00",
        endLocal: date + "T18:00",
      };
      const key = randomUUID();
      const submit = () => app.inject({
        method: "POST",
        url,
        headers: { ...headers, "idempotency-key": key },
        payload: draft,
      });
      const [left, right] = await Promise.all([submit(), submit()]);
      assert.deepEqual([left.statusCode, right.statusCode].sort(), [200, 201]);
      const plan = left.json().plan;
      assert.deepEqual(right.json().plan, plan);
      assert.equal(plan.startAt, date + "T06:00:00.000Z");
      assert.equal(plan.endAt, date + "T15:00:00.000Z");
      assert.equal(plan.active, false);
      assert.equal(plan.revision, 0);
      const persisted = await app.inject({ method: "GET", url, headers });
      assert.equal(persisted.statusCode, 200);
      assert.deepEqual(persisted.json(), { plans: [plan], hasMore: false });

      const invalidPayloads = [
        { ...draft, active: true },
        { ...draft, startLocal: "2026-02-30T09:00" },
        { ...draft, endLocal: draft.startLocal },
        { ...draft, startLocal: "2000-01-01T09:00", endLocal: "2000-01-01T18:00" },
        { ...draft, locationId: randomUUID() },
      ];
      for (const [index, payload] of invalidPayloads.entries()) {
        const rejected = await app.inject({
          method: "POST", url,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload,
        });
        assert.equal(rejected.statusCode, [400, 422, 422, 409, 409][index]);
      }
      const conflict = await app.inject({
        method: "POST", url,
        headers: { ...headers, "idempotency-key": key },
        payload: { ...draft, endLocal: date + "T17:00" },
      });
      assert.equal(conflict.statusCode, 409);

      const data = await pool.query(
        `SELECT shift.active AS shift_active, profile.bookable, binding.active AS location_active,
                service.active AS service_active, svc_assignment.active AS service_assignment_active
           FROM cookie_scheduling.shift_windows shift
           JOIN cookie_staff.staff_profiles profile ON profile.tenant_id=shift.tenant_id AND profile.id=shift.staff_id
           JOIN cookie_staff.location_assignments binding ON binding.tenant_id=shift.tenant_id
             AND binding.staff_id=shift.staff_id AND binding.location_id=shift.location_id
           JOIN cookie_staff.service_assignments svc_assignment ON svc_assignment.tenant_id=binding.tenant_id
             AND svc_assignment.staff_id=binding.staff_id AND svc_assignment.location_id=binding.location_id
           JOIN cookie_catalog.services service ON service.tenant_id=svc_assignment.tenant_id AND service.id=svc_assignment.service_id
          WHERE shift.tenant_id=$1::uuid`,
        [owner.tenantId],
      );
      assert.deepEqual(data.rows, [{
        shift_active: false,
        bookable: false,
        location_active: false,
        service_active: false,
        service_assignment_active: false,
      }]);
      const evidence = await pool.query(
        `SELECT
          (SELECT count(*)::int FROM cookie_scheduling.shift_draft_receipts WHERE tenant_id=$1::uuid) AS receipts,
          (SELECT count(*)::int FROM cookie_scheduling.shift_draft_audit WHERE tenant_id=$1::uuid AND operation='create') AS audits`,
        [owner.tenantId],
      );
      assert.deepEqual(evidence.rows[0], { receipts: 1, audits: 1 });
      // Revoked plan permission must deny reads and also deny receipt replay.
      await pool.query(
        `UPDATE cookie_identity.roles SET permissions=array_remove(
            array_remove(permissions,'schedule.shift.plan.read'),'schedule.shift.plan.create')
          WHERE tenant_id=$1::uuid`,
        [owner.tenantId],
      );
      assert.equal((await app.inject({ method: "GET", url, headers })).statusCode, 403);
      assert.equal((await submit()).statusCode, 403);
      await app.inject({ method: "POST", url: "/v1/auth/logout", headers });
      assert.equal((await app.inject({ method: "GET", url, headers })).statusCode, 401);
    } finally {
      await disabled.close();
      await app.close();
      await pool.end();
    }
  },
);
