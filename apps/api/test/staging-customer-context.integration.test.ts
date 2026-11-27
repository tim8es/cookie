import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createApp } from "../src/app.js";
import { provisionStagingCustomer } from "../../../packages/domain-customers/src/staging-customer.js";
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
  "staging Customer context is exact-link-bound, client-only and fail-closed",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 6,
    });
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
      stagingPublicationRoutes: { pool, verifier: sessions, enabled: true },
    });
    const disabled = createApp(pool, {
      stagingPublicationRoutes: { pool, verifier: sessions, enabled: false },
    });
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const identity = randomUUID();
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [identity],
      );
      const owner = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: identity,
        organizationName: "Synthetic context",
        locationName: "Branch",
        timeZone: "UTC",
        idempotencyKey: randomUUID(),
      });
      const other = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: identity,
        organizationName: "Synthetic second context",
        locationName: "Branch",
        timeZone: "UTC",
        idempotencyKey: randomUUID(),
      });
      const tenantId = owner.tenantId;
      const root = "/v1/organizations/" + tenantId;
      const url = root + "/staging-customer-context";
      const login = async (raw: string) => {
        const result = await app.inject({
          method: "POST",
          url: "/v1/auth/telegram/exchange",
          payload: { initData: raw },
        });
        assert.equal(result.statusCode, 201);
        return { authorization: "Bearer " + result.json().accessToken };
      };
      const ownerProof = proof(19190039);
      await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId,
        ownerIdentityId: identity,
        rawInitData: ownerProof,
        consentConfirmed: true,
      });
      await assert.rejects(
        provisionStagingCustomer(pool, verifier, SECRET, {
          tenantId,
          rawInitData: ownerProof,
          consentConfirmed: true,
        }),
      );
      const ownerHeaders = await login(ownerProof);
      assert.equal(
        (await app.inject({ method: "GET", url, headers: ownerHeaders }))
          .statusCode,
        403,
      );
      const customerProof = proof(19190040);
      const input = {
        tenantId,
        rawInitData: customerProof,
        consentConfirmed: true as const,
      };
      await assert.rejects(
        provisionStagingCustomer(pool, verifier, SECRET, {
          ...input,
          rawInitData: customerProof + "x",
        }),
      );
      const before = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: customerProof },
      });
      assert.equal(before.statusCode, 401, "unlinked proof cannot enroll");
      const [a, b] = await Promise.all([
        provisionStagingCustomer(pool, verifier, SECRET, input),
        provisionStagingCustomer(pool, verifier, SECRET, input),
      ]);
      assert.deepEqual(a, b);
      await assert.rejects(
        provisionStagingCustomer(pool, verifier, SECRET, {
          ...input,
          tenantId: other.tenantId,
        }),
      );
      const headers = await login(customerProof);
      const context = await app.inject({ method: "GET", url, headers });
      assert.equal(context.statusCode, 200);
      assert.equal(context.headers["cache-control"], "no-store");
      assert.deepEqual(context.json(), a);
      assert.deepEqual(Object.keys(context.json()).sort(), [
        "customerId",
        "tenantId",
      ]);
      assert.equal(
        (await disabled.inject({ method: "GET", url, headers })).statusCode,
        404,
      );
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: url + "?customerId=" + randomUUID(),
            headers,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: url.replace(tenantId, other.tenantId),
            headers,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: root + "/services", headers }))
          .statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: root + "/bookings",
            headers,
            payload: {},
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ method: "POST", url, payload: {}, headers }))
          .statusCode,
        404,
      );
      const rows = await pool.query(
        "SELECT identity_id::text,telegram_link_id::text FROM cookie_customers.staging_customer_identities WHERE tenant_id=$1::uuid",
        [tenantId],
      );
      assert.equal(rows.rowCount, 1);
      const bound = rows.rows[0];
      assert.notEqual(bound.identity_id, identity);
      const role = await pool.query(
        "SELECT r.base_type,r.permissions FROM cookie_identity.roles r JOIN cookie_identity.role_assignments a ON a.tenant_id=r.tenant_id AND a.role_id=r.id WHERE a.tenant_id=$1::uuid AND a.identity_id=$2::uuid",
        [tenantId, bound.identity_id],
      );
      assert.deepEqual(role.rows, [
        {
          base_type: "client",
          permissions: [
            "staging.customer.context.read",
            "staging.customer.offers.read",
            "staging.customer.booking.create",
            "staging.customer.bookings.read",
            "staging.customer.booking.cancel",
            "staging.customer.booking.reschedule",
          ],
        },
      ]);
      await pool.query(
        "UPDATE cookie_identity.roles SET active=false WHERE tenant_id=$1::uuid AND base_type='client'",
        [tenantId],
      );
      assert.equal(
        (await app.inject({ method: "GET", url, headers })).statusCode,
        403,
      );
      await pool.query(
        "UPDATE cookie_identity.roles SET active=true WHERE tenant_id=$1::uuid AND base_type='client'",
        [tenantId],
      );
      await pool.query(
        "UPDATE cookie_identity.telegram_identity_links SET revoked_at=clock_timestamp() WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [tenantId, bound.telegram_link_id],
      );
      assert.equal(
        (await app.inject({ method: "GET", url, headers })).statusCode,
        401,
      );
      await assert.rejects(
        provisionStagingCustomer(pool, verifier, SECRET, input),
      );
      const count = await pool.query(
        "SELECT count(*)::int AS count FROM cookie_customers.staging_customer_identities WHERE tenant_id=$1::uuid",
        [tenantId],
      );
      assert.equal(count.rows[0].count, 1);
      const secondProof = proof(19190041);
      const second = await provisionStagingCustomer(pool, verifier, SECRET, {
        tenantId,
        rawInitData: secondProof,
        consentConfirmed: true,
      });
      assert.notEqual(second.customerId, a.customerId);
      const secondHeaders = await login(secondProof);
      assert.deepEqual(
        (
          await app.inject({ method: "GET", url, headers: secondHeaders })
        ).json(),
        second,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/v1/auth/logout",
            headers: secondHeaders,
          })
        ).statusCode,
        204,
      );
      assert.equal(
        (await app.inject({ method: "GET", url, headers: secondHeaders }))
          .statusCode,
        401,
      );
    } finally {
      await disabled.close();
      await app.close();
      await pool.end();
    }
  },
);
