import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createApp } from "../src/app.js";
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
      await revokeStagingGrant(pool, owner.tenantId);
      assert.equal((await submit()).json().error, "grant-unavailable");
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(permissions,'staging.shift.publish') WHERE tenant_id=$1::uuid",
        [owner.tenantId],
      );
      assert.equal((await submit()).statusCode, 403);
      const denied = await pool.query(
        `SELECT count(*)::int AS total
           FROM cookie_identity.authorization_audit
          WHERE tenant_id=$1::uuid AND permission='staging.shift.publish'
            AND NOT allowed`,
        [owner.tenantId],
      );
      assert.ok(denied.rows[0]?.total >= 1);
      await app.inject({ method: "POST", url: "/v1/auth/logout", headers });
      assert.equal((await submit()).statusCode, 401);
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
