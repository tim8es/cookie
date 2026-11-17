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

const BOT = "123456789:synthetic_locations_not_real_bot";
const SECRET = Buffer.alloc(32, 0x33);

function signedProof(): string {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: randomUUID(),
    user: JSON.stringify({ id: 260028001, first_name: "Synthetic" }),
  };
  const check = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + "=" + value)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return (
    Object.entries(fields)
      .map(([key, value]) => key + "=" + encodeURIComponent(value))
      .join("&") +
    "&hash=" +
    hash
  );
}

test(
  "real owner Locations list/create: tenant-safe, actual IANA zone and exact durable replay",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-live-tenant-location-qa",
      max: 6,
    });
    const ownerId = randomUUID();
    const foreignOwner = randomUUID();
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
      locationRoutes: { pool, verifier: sessions },
    });
    const disabled = createApp(pool);
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid),($2::uuid)",
        [ownerId, foreignOwner],
      );
      const owner = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: ownerId,
        organizationName: "Synthetic multi-location salon",
        locationName: "First branch",
        timeZone: "Europe/Moscow",
        idempotencyKey: "branch-owner-" + randomUUID(),
      });
      const other = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: foreignOwner,
        organizationName: "Other tenant secret",
        locationName: "Foreign branch secret",
        timeZone: "UTC",
        idempotencyKey: "branch-foreign-" + randomUUID(),
      });
      const url = "/v1/organizations/" + owner.tenantId + "/locations";
      assert.equal(
        (await disabled.inject({ method: "GET", url })).statusCode,
        404,
      );
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
      const proof = signedProof();
      await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: owner.tenantId,
        ownerIdentityId: ownerId,
        rawInitData: proof,
        consentConfirmed: true,
      });
      const exchange = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: proof },
      });
      assert.equal(exchange.statusCode, 201);
      const token: string = exchange.json().accessToken;
      const headers = { authorization: "Bearer " + token };

      const initial = await app.inject({ method: "GET", url, headers });
      assert.equal(initial.statusCode, 200);
      assert.equal(initial.headers["cache-control"], "no-store");
      assert.equal(initial.headers.vary, "Authorization");
      assert.equal(initial.json().locations.length, 1);
      assert.equal(initial.json().locations[0].id, owner.locationId);
      assert.equal(initial.json().locations[0].timeZone, "Europe/Moscow");

      const foreign = await app.inject({
        method: "GET",
        url: "/v1/organizations/" + other.tenantId + "/locations",
        headers,
      });
      assert.equal(foreign.statusCode, 403);
      assert.doesNotMatch(
        foreign.body,
        /Other tenant secret|Foreign branch secret/,
      );

      const draft = {
        displayName: "  Вторая студия  ",
        timeZone: "Europe/Moscow",
      };
      const key = "location-" + randomUUID();
      const submit = () =>
        app.inject({
          method: "POST",
          url,
          headers: { ...headers, "idempotency-key": key },
          payload: draft,
        });
      const [one, two] = await Promise.all([submit(), submit()]);
      assert.deepEqual([one.statusCode, two.statusCode].sort(), [200, 201]);
      const saved = one.json().location;
      assert.deepEqual(saved, two.json().location);
      assert.equal(saved.displayName, "Вторая студия");
      assert.equal(saved.timeZone, "Europe/Moscow");
      assert.match(saved.id, /^[0-9a-f-]{36}$/);
      assert.ok(Number.isFinite(Date.parse(saved.createdAt)));

      const malformed = await app.inject({
        method: "POST",
        url,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { ...draft, ownerIdentityId: foreignOwner },
      });
      assert.equal(malformed.statusCode, 400);
      const fakeZone = await app.inject({
        method: "POST",
        url,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { displayName: "Wrong zone", timeZone: "Mars/Olympus" },
      });
      assert.equal(fakeZone.statusCode, 400);
      const changed = await app.inject({
        method: "POST",
        url,
        headers: { ...headers, "idempotency-key": key },
        payload: { ...draft, displayName: "Changed request" },
      });
      assert.equal(changed.statusCode, 409);
      const createForeign = await app.inject({
        method: "POST",
        url: "/v1/organizations/" + other.tenantId + "/locations",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: draft,
      });
      assert.equal(createForeign.statusCode, 403);

      const list = await app.inject({ method: "GET", url, headers });
      assert.equal(list.statusCode, 200);
      assert.equal(list.json().locations.length, 2);
      assert.deepEqual(
        new Set(
          list.json().locations.map((branch: { id: string }) => branch.id),
        ),
        new Set([owner.locationId, saved.id]),
      );

      const db = await pool.query<{ total: number; receipts: number }>(
        `SELECT
          (SELECT count(*)::int FROM cookie_tenancy.locations
            WHERE tenant_id=$1::uuid) AS total,
          (SELECT count(*)::int FROM cookie_tenancy.location_create_receipts
            WHERE tenant_id=$1::uuid) AS receipts`,
        [owner.tenantId],
      );
      assert.deepEqual(db.rows[0], { total: 2, receipts: 1 });

      // 100 locations (incl. default branch) is the upper F1 limit.
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
          SELECT $1::uuid, gen_random_uuid(), 'Synthetic branch ' || n, 'UTC'
            FROM generate_series(1,97) AS n`,
        [owner.tenantId],
      );
      const last = () =>
        app.inject({
          method: "POST",
          url,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: { displayName: "Final branch", timeZone: "UTC" },
        });
      const outcomes = await Promise.all([last(), last()]);
      const statuses = outcomes.map((item) => item.statusCode).sort();
      assert.deepEqual(statuses, [201, 409]);
      const capped = outcomes.find((item) => item.statusCode === 409);
      assert.equal(capped?.json().error, "location-limit");
      assert.equal((await submit()).statusCode, 200);
      assert.equal(
        (await app.inject({ method: "GET", url, headers })).json().locations
          .length,
        100,
      );

      await pool.query(
        `UPDATE cookie_identity.roles
          SET permissions=ARRAY['organization.context.read']::text[]
          WHERE tenant_id=$1::uuid AND base_type='owner'`,
        [owner.tenantId],
      );
      assert.equal(
        (await app.inject({ method: "GET", url, headers })).statusCode,
        403,
      );
      assert.equal((await submit()).statusCode, 403);
      await app.inject({ method: "POST", url: "/v1/auth/logout", headers });
      assert.equal(
        (await app.inject({ method: "GET", url, headers })).statusCode,
        401,
      );
    } finally {
      await disabled.close();
      await app.close();
      await pool.end();
    }
  },
);
