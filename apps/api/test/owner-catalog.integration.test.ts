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
  "real owner catalog create/list persists, deduplicates and denies revoked/foreign access",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-owner-catalog-e2e",
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
        organizationName: "Synthetic catalog salon",
        locationName: "Central",
        timeZone: "UTC",
        idempotencyKey: "catalog-setup-" + randomUUID(),
      });
      const signed = proof(19190001);
      await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: owner.tenantId,
        ownerIdentityId: ownerId,
        rawInitData: signed,
        consentConfirmed: true,
      });
      const prefix = "/v1/organizations/" + owner.tenantId + "/services";
      const absent = await disabled.inject({ method: "GET", url: prefix });
      assert.equal(absent.statusCode, 404);
      assert.equal(
        (await app.inject({ method: "GET", url: prefix })).statusCode,
        401,
      );
      const exchange = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: signed },
      });
      assert.equal(exchange.statusCode, 201);
      const token: string = exchange.json().accessToken;
      const headers = { authorization: "Bearer " + token };
      const empty = await app.inject({ method: "GET", url: prefix, headers });
      assert.equal(empty.statusCode, 200);
      assert.equal(empty.headers["cache-control"], "no-store");
      assert.deepEqual(empty.json(), { services: [] });
      const foreign = await app.inject({
        method: "GET",
        url: "/v1/organizations/" + randomUUID() + "/services",
        headers,
      });
      assert.equal(foreign.statusCode, 403);
      const draft = {
        displayName: " Synthetic haircut ",
        durationMinutes: 60,
        basePriceKopecks: 150000,
      };
      const key = "catalog-post-" + randomUUID();
      const submit = () =>
        app.inject({
          method: "POST",
          url: prefix,
          headers: { ...headers, "idempotency-key": key },
          payload: draft,
        });
      const [first, second] = await Promise.all([submit(), submit()]);
      assert.deepEqual(
        [first.statusCode, second.statusCode].sort(),
        [200, 201],
      );
      const a = first.json().service;
      const b = second.json().service;
      assert.deepEqual(a, b);
      assert.equal(a.active, false);
      assert.equal(a.displayName, "Synthetic haircut");
      assert.equal(a.basePriceKopecks, 150000);
      assert.match(a.id, /^[0-9a-f-]{36}$/);
      const changed = await app.inject({
        method: "POST",
        url: prefix,
        headers: { ...headers, "idempotency-key": key },
        payload: { ...draft, durationMinutes: 30 },
      });
      assert.equal(changed.statusCode, 409);
      const invalid = await app.inject({
        method: "POST",
        url: prefix,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { ...draft, active: true },
      });
      assert.equal(invalid.statusCode, 400);
      const list = await app.inject({ method: "GET", url: prefix, headers });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(list.json().services, [a]);
      const saved = await pool.query(
        "SELECT count(*)::int AS count FROM cookie_catalog.services WHERE tenant_id=$1::uuid",
        [owner.tenantId],
      );
      assert.equal(saved.rows[0].count, 1);
      const editUrl = prefix + "/" + a.id;
      const edit = {
        displayName: "Synthetic edited haircut",
        durationMinutes: 45,
        basePriceKopecks: 120050,
        expectedRevision: 0,
      };
      const editKey = randomUUID();
      const change = (
        payload: object,
        idempotencyKey = editKey,
        url = editUrl,
      ) =>
        app.inject({
          method: "PATCH",
          url,
          headers: { ...headers, "idempotency-key": idempotencyKey },
          payload,
        });
      assert.equal(a.revision, 0);
      assert.equal(
        (await disabled.inject({ method: "PATCH", url: editUrl })).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ method: "PATCH", url: editUrl })).statusCode,
        401,
      );
      assert.equal(
        (
          await change(
            edit,
            randomUUID(),
            "/v1/organizations/" + randomUUID() + "/services/" + a.id,
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (await change(edit, randomUUID(), prefix + "/" + randomUUID()))
          .statusCode,
        404,
      );

      const [updatedA, updatedB] = await Promise.all([
        change(edit),
        change(edit),
      ]);
      assert.equal(updatedA.statusCode, 200);
      assert.equal(updatedB.statusCode, 200);
      assert.equal(updatedA.headers["cache-control"], "no-store");
      const revisionOne = updatedA.json().service;
      assert.deepEqual(updatedB.json().service, revisionOne);
      assert.deepEqual(revisionOne, {
        ...a,
        displayName: edit.displayName,
        durationMinutes: 45,
        basePriceKopecks: 120050,
        revision: 1,
      });
      assert.equal(
        (await change({ ...edit, durationMinutes: 46 })).statusCode,
        409,
      );
      const stale = await change(edit, randomUUID());
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().error, "stale-revision");

      // Concurrent distinct edits from the same revision cannot both commit.
      const next = { ...edit, expectedRevision: 1 };
      const race = await Promise.all([
        change({ ...next, durationMinutes: 50 }, randomUUID()),
        change({ ...next, durationMinutes: 55 }, randomUUID()),
      ]);
      assert.deepEqual(
        race.map((result) => result.statusCode).sort(),
        [200, 409],
      );
      const revisionTwo = race
        .find((result) => result.statusCode === 200)!
        .json().service;
      assert.equal(revisionTwo.revision, 2);

      // Old receipts are immutable, but GET is authoritative current data.
      assert.deepEqual((await change(edit)).json().service, revisionOne);
      const createReplay = await submit();
      assert.equal(createReplay.statusCode, 200);
      assert.deepEqual(createReplay.json().service, a);
      assert.deepEqual(
        (await app.inject({ method: "GET", url: prefix, headers })).json()
          .services,
        [revisionTwo],
      );

      for (const invalidEdit of [
        { ...next, active: true },
        { ...next, expectedRevision: -1 },
        { ...next, basePriceKopecks: 12.5 },
        { ...next, durationMinutes: 0 },
      ]) {
        assert.equal((await change(invalidEdit, randomUUID())).statusCode, 400);
      }
      // Use a real scoped staff/assignment; service edits must not change
      // references and must fail when there is an active assignment.
      const staffId = randomUUID();
      await pool.query(
        "INSERT INTO cookie_staff.staff_profiles(tenant_id,id,display_name) VALUES($1::uuid,$2::uuid,'Synthetic draft staff')",
        [owner.tenantId, staffId],
      );
      await pool.query(
        "INSERT INTO cookie_staff.location_assignments(tenant_id,staff_id,location_id) VALUES($1::uuid,$2::uuid,$3::uuid)",
        [owner.tenantId, staffId, owner.locationId],
      );
      await pool.query(
        "INSERT INTO cookie_staff.service_assignments(tenant_id,staff_id,location_id,service_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)",
        [owner.tenantId, staffId, owner.locationId, a.id],
      );
      const binding = [owner.tenantId, staffId, owner.locationId, a.id];
      const third = { ...edit, expectedRevision: 2 };
      const successful = await change(third, randomUUID());
      assert.equal(successful.statusCode, 200);
      const assignment = await pool.query(
        "SELECT active FROM cookie_staff.service_assignments WHERE tenant_id=$1::uuid AND staff_id=$2::uuid AND location_id=$3::uuid AND service_id=$4::uuid",
        binding,
      );
      assert.deepEqual(assignment.rows, [{ active: false }]);
      await pool.query(
        "UPDATE cookie_staff.service_assignments SET active=true WHERE tenant_id=$1::uuid AND staff_id=$2::uuid AND location_id=$3::uuid AND service_id=$4::uuid",
        binding,
      );
      assert.equal(
        (await change({ ...edit, expectedRevision: 3 }, randomUUID()))
          .statusCode,
        404,
      );
      await pool.query(
        "UPDATE cookie_staff.service_assignments SET active=false WHERE tenant_id=$1::uuid AND staff_id=$2::uuid AND location_id=$3::uuid AND service_id=$4::uuid",
        binding,
      );
      await pool.query(
        "UPDATE cookie_catalog.services SET active=true WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [owner.tenantId, a.id],
      );
      assert.equal(
        (await change({ ...edit, expectedRevision: 3 }, randomUUID()))
          .statusCode,
        404,
      );
      const count = await pool.query(
        `SELECT
          (SELECT count(*)::int FROM cookie_catalog.service_create_receipts WHERE tenant_id=$1::uuid) AS creates,
          (SELECT count(*)::int FROM cookie_catalog.service_edit_receipts WHERE tenant_id=$1::uuid) AS edits,
          (SELECT draft_revision FROM cookie_catalog.services WHERE tenant_id=$1::uuid AND id=$2::uuid) AS revision`,
        [owner.tenantId, a.id],
      );
      assert.deepEqual(count.rows[0], { creates: 1, edits: 3, revision: 3 });

      // A revoked permission also denies committed receipt replay.
      // Permission reduction denies even a still-valid authenticated bearer.
      await pool.query(
        "UPDATE cookie_identity.roles SET permissions=ARRAY[\u0027organization.context.read\u0027]::text[] WHERE tenant_id=$1::uuid",
        [owner.tenantId],
      );
      assert.equal(
        (await app.inject({ method: "GET", url: prefix, headers })).statusCode,
        403,
      );
      assert.equal((await submit()).statusCode, 403);
      assert.equal((await change(edit)).statusCode, 403);
      await app.inject({ method: "POST", url: "/v1/auth/logout", headers });
      assert.equal(
        (await app.inject({ method: "GET", url: prefix, headers })).statusCode,
        401,
      );
    } finally {
      await disabled.close();
      await app.close();
      await pool.end();
    }
  },
);
