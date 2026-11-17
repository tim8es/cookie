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
  "explicit staging grant enforces unique seat capacity, current owner role, and no publication before grant",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-staging-capacity-test",
      max: 8,
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
      staffRoutes: { pool, verifier: sessions },
      stagingPublicationRoutes: { pool, verifier: sessions, enabled: true },
    });
    const disabled = createApp(pool, {
      stagingPublicationRoutes: { pool, verifier: sessions, enabled: false },
    });
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const identityId = randomUUID();
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [identityId],
      );
      const owner = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: identityId,
        organizationName: "Synthetic licensed studio",
        locationName: "Synthetic branch",
        timeZone: "UTC",
        idempotencyKey: randomUUID(),
      });
      const signed = proof(19190019);
      await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: owner.tenantId,
        ownerIdentityId: identityId,
        rawInitData: signed,
        consentConfirmed: true,
      });
      const exchange = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: signed },
      });
      assert.equal(exchange.statusCode, 201);
      const headers = {
        authorization: "Bearer " + exchange.json().accessToken,
      };
      const tenant = owner.tenantId;
      const root = "/v1/organizations/" + tenant;
      const url = root + "/staging-publication";
      const read = () => app.inject({ method: "GET", url, headers });
      const capacity = async () => {
        const response = await read();
        assert.equal(response.statusCode, 200);
        return response.json().capacity;
      };
      const post = (input: object, key = randomUUID()) =>
        app.inject({
          method: "POST",
          url,
          headers: { ...headers, "idempotency-key": key },
          payload: input,
        });
      const unauthorized = await app.inject({ method: "GET", url });
      assert.equal(unauthorized.statusCode, 401);
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: "/v1/organizations/" + randomUUID() + "/staging-publication",
            headers,
          })
        ).statusCode,
        403,
      );
      assert.deepEqual(await capacity(), {
        state: "unconfigured",
        seatLimit: null,
        usedSeats: 0,
        expiresAt: null,
      });
      assert.equal(
        (await disabled.inject({ method: "GET", url, headers })).json().capacity
          .state,
        "disabled",
      );
      assert.equal(
        (await disabled.inject({ method: "POST", url, headers, payload: {} }))
          .statusCode,
        404,
      );
      const created = await app.inject({
        method: "POST",
        url: root + "/services",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          displayName: "Synthetic service",
          durationMinutes: 30,
          basePriceKopecks: 100000,
        },
      });
      assert.equal(created.statusCode, 201);
      const serviceId: string = created.json().service.id;
      const createStaff = async () => {
        const response = await app.inject({
          method: "POST",
          url: root + "/staff",
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            displayName: "Synthetic capacity staff",
            positionTitle: "Stylist",
            locationId: owner.locationId,
            serviceId,
          },
        });
        assert.equal(response.statusCode, 201);
        return response.json().staff.id as string;
      };
      const first = await createStaff();
      const second = await createStaff();
      const draft = (staffId: string, expectedServiceRevision = 0) => ({
        staffId,
        locationId: owner.locationId,
        serviceId,
        expectedServiceRevision,
      });
      assert.equal(
        (await post(draft(first))).json().error,
        "grant-unavailable",
      );
      const expiry = new Date(Date.now() + 3600000).toISOString();
      const grantId = await issueStagingGrant(pool, tenant, 1, expiry);
      assert.equal(await issueStagingGrant(pool, tenant, 1, expiry), grantId);
      await assert.rejects(issueStagingGrant(pool, tenant, 2, expiry));
      assert.deepEqual(await capacity(), {
        state: "active",
        seatLimit: 1,
        usedSeats: 0,
        expiresAt: expiry,
      });
      assert.equal(
        (await post({ ...draft(first), active: true })).statusCode,
        400,
      );
      assert.equal(
        (await post({ ...draft(first), locationId: randomUUID() })).json()
          .error,
        "target-unavailable",
      );
      assert.equal(
        (await post({ ...draft(first), serviceId: randomUUID() })).json().error,
        "target-unavailable",
      );
      assert.equal(
        (await post(draft(first, 1))).json().error,
        "stale-revision",
      );
      const keys = [randomUUID(), randomUUID()];
      const inputs = [draft(first), draft(second)];
      const race = await Promise.all(
        inputs.map((input, i) => post(input, keys[i])),
      );
      assert.deepEqual(race.map((r) => r.statusCode).sort(), [201, 409]);
      const won = race.findIndex((r) => r.statusCode === 201);
      assert.equal(race[1 - won]!.json().error, "seat-limit");
      const winner = inputs[won]!;
      const replay = await post(winner, keys[won]);
      assert.equal(replay.statusCode, 200);
      assert.deepEqual(replay.json(), race[won]!.json());
      assert.equal(
        (
          await post({ ...winner, expectedServiceRevision: 1 }, keys[won])
        ).json().error,
        "idempotency-conflict",
      );
      assert.equal((await post(winner)).json().error, "already-bookable");
      const third = await createStaff();
      assert.equal((await post(draft(third, 1))).json().error, "seat-limit");
      const counts = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM cookie_staff.staff_profiles WHERE tenant_id=$1::uuid AND active AND bookable) AS seats,
           (SELECT count(*)::int FROM cookie_staff.location_assignments WHERE tenant_id=$1::uuid AND active) AS locations,
           (SELECT count(*)::int FROM cookie_staff.service_assignments WHERE tenant_id=$1::uuid AND active) AS assignments,
           (SELECT count(*)::int FROM cookie_staff.staging_publication_receipts WHERE tenant_id=$1::uuid) AS receipts,
           (SELECT count(*)::int FROM cookie_catalog.services WHERE tenant_id=$1::uuid AND active AND first_published_at IS NOT NULL AND draft_revision=1) AS services,
           (SELECT count(*)::int FROM cookie_scheduling.shift_windows WHERE tenant_id=$1::uuid AND active) AS shifts`,
        [tenant],
      );
      assert.deepEqual(counts.rows[0], {
        seats: 1,
        locations: 1,
        assignments: 1,
        receipts: 1,
        services: 1,
        shifts: 0,
      });
      // An additional branch and assignment on the same StaffProfile does not
      // consume another seat. These are synthetic trusted storage fixtures.
      const secondBranch = randomUUID();
      await pool.query(
        "INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone) VALUES($1::uuid,$2::uuid,'Synthetic second branch','UTC')",
        [tenant, secondBranch],
      );
      await pool.query(
        "INSERT INTO cookie_staff.location_assignments(tenant_id,staff_id,location_id,active) VALUES($1::uuid,$2::uuid,$3::uuid,true)",
        [tenant, winner.staffId, secondBranch],
      );
      await pool.query(
        "INSERT INTO cookie_staff.service_assignments(tenant_id,staff_id,location_id,service_id,active) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,true)",
        [tenant, winner.staffId, secondBranch, serviceId],
      );
      assert.equal((await capacity()).usedSeats, 1);
      await pool.query(
        "UPDATE cookie_catalog.services SET active=false,first_published_at=NULL WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [tenant, serviceId],
      );
      await pool.query(
        "UPDATE cookie_staff.service_assignments SET active=false WHERE tenant_id=$1::uuid AND service_id=$2::uuid",
        [tenant, serviceId],
      );
      const edit = await app.inject({
        method: "PATCH",
        url: root + "/services/" + serviceId,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          displayName: "Synthetic prohibited edit",
          durationMinutes: 60,
          basePriceKopecks: 0,
          expectedRevision: 1,
        },
      });
      assert.equal(
        edit.statusCode,
        404,
        "publication history must survive deactivation",
      );
      // Expiry uses DB time; modify only a synthetic fixture.
      await pool.query(
        "UPDATE cookie_entitlement.staging_publication_grants SET issued_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE tenant_id=$1::uuid",
        [tenant],
      );
      assert.equal((await capacity()).state, "expired");
      assert.equal(
        (await post(draft(third, 1))).json().error,
        "grant-unavailable",
      );
      await revokeStagingGrant(pool, tenant);
      assert.equal((await capacity()).state, "revoked");
      assert.equal(
        (await post(winner, keys[won])).json().error,
        "grant-unavailable",
      );
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=array_remove(array_remove(permissions,'staging.entitlement.read'),'staging.staff.publish') WHERE tenant_id=$1::uuid",
        [tenant],
      );
      assert.equal((await read()).statusCode, 403);
      assert.equal((await post(winner, keys[won])).statusCode, 403);
      await app.inject({ method: "POST", url: "/v1/auth/logout", headers });
      assert.equal((await read()).statusCode, 401);
    } finally {
      await disabled.close();
      await app.close();
      await pool.end();
    }
  },
);
