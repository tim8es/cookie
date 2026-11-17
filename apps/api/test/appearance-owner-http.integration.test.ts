import assert from "node:assert/strict";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";
import sharp from "sharp";

import { postgresAppearanceAssetOwnership } from "../../../packages/appearance-asset-adapter/src/index.js";
import { createBrandConfig } from "../../../packages/domain-appearance/src/index.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { linkVerifiedTelegramOwner } from "../../../packages/platform-identity/src/link-telegram-owner.js";
import {
  createPostgresVerifiedTelegramLinkResolver,
  createTelegramMiniAppProofVerifier,
  PostgresOpaqueTelegramSessions,
} from "../../../packages/platform-identity/src/index.js";
import { provisionOwnerWorkspace } from "../../../packages/platform-identity/src/provision-owner-workspace.js";
import { createApp } from "../src/app.js";
import { registerRealAppearanceRoutes } from "../src/appearance-http.js";
import { registerPrivateAppearanceAssetRoutes } from "../src/appearance-assets-http.js";

const BOT = "123456789:synthetic_appearance_not_real_bot";
const SECRET = Buffer.alloc(32, 0x4b);

function signedProof(): string {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: randomUUID(),
    user: JSON.stringify({
      id: randomInt(1_000_000_000, 2_000_000_000),
      first_name: "Synthetic",
    }),
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
  "fresh PostgreSQL owner can save and publish Appearance through verified auth",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-appearance-http-e2e",
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
    const app = createApp(pool, { telegramAuthRoutes: { sessions } });
    registerRealAppearanceRoutes(app, {
      pool,
      verifier: sessions,
      assets: postgresAppearanceAssetOwnership,
      stagingPublicationEnabled: true,
    });
    registerPrivateAppearanceAssetRoutes(app, {
      pool,
      verifier: sessions,
      quota: { maxAssets: 1, maxBytes: 2 * 1024 * 1024 },
    });
    const disabled = createApp(pool);
    const draftOnly = createApp(pool, {
      appearanceDraftRoutes: { pool, verifier: sessions },
    });
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const ownerId = randomUUID();
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [ownerId],
      );
      const owner = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: ownerId,
        organizationName: "Synthetic appearance salon",
        locationName: "Central",
        timeZone: "UTC",
        idempotencyKey: "appearance-setup-" + randomUUID(),
      });
      const proof = signedProof();
      await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: owner.tenantId,
        ownerIdentityId: ownerId,
        rawInitData: proof,
        consentConfirmed: true,
      });
      const prefix = "/v1/organizations/" + owner.tenantId + "/appearance";
      const url = prefix + "/draft";
      assert.equal(
        (await disabled.inject({ method: "GET", url })).statusCode,
        404,
      );
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
      const exchange = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: proof },
      });
      assert.equal(exchange.statusCode, 201);
      const token: string = exchange.json().accessToken;
      const headers = { authorization: "Bearer " + token };
      const capability = prefix + "/assets/capability";
      const enabled = await app.inject({
        method: "GET",
        url: capability,
        headers,
      });
      assert.equal(enabled.statusCode, 200);
      assert.deepEqual(enabled.json(), { enabled: true });
      assert.equal(
        (await draftOnly.inject({ method: "GET", url: capability, headers }))
          .statusCode,
        404,
      );
      const uploadUrl = prefix + "/assets/logo";
      const raw = await sharp({
        create: { width: 3, height: 2, channels: 3, background: "red" },
      })
        .jpeg()
        .toBuffer();
      const uploadHeaders = { ...headers, "content-type": "image/jpeg" };
      const upload = (payload: Buffer, target = uploadUrl) =>
        app.inject({
          method: "POST",
          url: target,
          headers: uploadHeaders,
          payload,
        });
      assert.equal(
        (
          await disabled.inject({
            method: "GET",
            url: uploadUrl + "/" + randomUUID(),
            headers,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: uploadUrl,
            headers: { "content-type": "image/jpeg" },
            payload: raw,
          })
        ).statusCode,
        401,
      );
      assert.equal((await upload(Buffer.from("bad"))).statusCode, 400);
      const accepted = await upload(raw);
      assert.equal(accepted.statusCode, 200, accepted.body);
      const assetId: string = accepted.json().asset.id;
      assert.deepEqual((await upload(raw)).json(), accepted.json());
      const exhausted = await upload(raw, prefix + "/assets/background");
      assert.equal(exhausted.statusCode, 409);
      assert.equal(exhausted.json().error, "appearance-storage-quota");
      const assetUrl = uploadUrl + "/" + assetId;
      const fetched = await app.inject({
        method: "GET",
        url: assetUrl,
        headers,
      });
      assert.equal(fetched.statusCode, 200);
      assert.equal(fetched.headers["content-type"], "image/png");
      assert.equal(fetched.headers["cache-control"], "no-store");
      assert.equal(fetched.headers["x-content-type-options"], "nosniff");
      assert.equal((await sharp(fetched.rawPayload).metadata()).format, "png");
      assert.equal(
        (await app.inject({ method: "GET", url: assetUrl })).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: prefix + "/assets/background/" + assetId,
            headers,
          })
        ).statusCode,
        404,
      );
      const otherTenant = randomUUID();
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url:
              "/v1/organizations/" +
              otherTenant +
              "/appearance/assets/logo/" +
              assetId,
            headers,
          })
        ).statusCode,
        403,
      );
      const read = () => app.inject({ method: "GET", url, headers });
      const initial = await read();
      assert.equal(initial.statusCode, 200);
      assert.equal(initial.json().draft.revision, 0);
      const config = createBrandConfig("forest");
      const draftRead = await draftOnly.inject({ method: "GET", url, headers });
      assert.equal(draftRead.statusCode, 200);
      assert.equal(draftRead.json().draft.revision, 0);
      const saved = await draftOnly.inject({
        method: "PUT",
        url,
        headers,
        payload: { expectedRevision: 0, config },
      });
      assert.equal(saved.statusCode, 200);
      assert.deepEqual(saved.json(), { draft: { revision: 1, config } });
      const linkedConfig = { ...config, logoAssetId: assetId };
      const linked = await app.inject({
        method: "PUT",
        url,
        headers,
        payload: { expectedRevision: 1, config: linkedConfig },
      });
      assert.equal(linked.statusCode, 200);
      assert.deepEqual(linked.json().draft, {
        revision: 2,
        config: linkedConfig,
      });
      const publish = () =>
        app.inject({
          method: "POST",
          url: prefix + "/publish",
          headers,
          payload: { expectedRevision: 2 },
        });
      const disabledPublish = await draftOnly.inject({
        method: "POST",
        url: prefix + "/publish",
        headers,
        payload: { expectedRevision: 2 },
      });
      assert.equal(disabledPublish.statusCode, 404);
      const statusUrl = prefix + "/publication";
      const status = () =>
        app.inject({ method: "GET", url: statusUrl, headers });
      assert.equal(
        (await draftOnly.inject({ method: "GET", url: statusUrl, headers }))
          .statusCode,
        404,
      );
      assert.deepEqual((await status()).json(), {
        draftRevision: 2,
        publishedRevision: null,
        canPublish: false,
      });
      const missingGrant = await publish();
      assert.equal(missingGrant.statusCode, 409);
      assert.equal(missingGrant.json().error, "appearance-grant-unavailable");
      const grantId = randomUUID();
      await pool.query(
        `INSERT INTO cookie_entitlement.staging_appearance_grants
          (tenant_id,id,issued_at,expires_at)
         VALUES($1::uuid,$2::uuid,clock_timestamp()-interval '2 hours',
                clock_timestamp()-interval '1 hour')`,
        [owner.tenantId, grantId],
      );
      assert.equal((await publish()).statusCode, 409);
      // Replace an expired synthetic fixture before any publication; the
      // product exposes no owner-controlled grant issue or renewal endpoint.
      await pool.query(
        "DELETE FROM cookie_entitlement.staging_appearance_grants WHERE tenant_id=$1::uuid",
        [owner.tenantId],
      );
      const activeGrant = randomUUID();
      await pool.query(
        `INSERT INTO cookie_entitlement.staging_appearance_grants
          (tenant_id,id,expires_at)
         VALUES($1::uuid,$2::uuid,clock_timestamp()+interval '1 hour')`,
        [owner.tenantId, activeGrant],
      );
      assert.deepEqual((await status()).json(), {
        draftRevision: 2,
        publishedRevision: null,
        canPublish: true,
      });
      const published = await publish();
      assert.equal(published.statusCode, 200);
      assert.equal(published.json().published.revision, 2);
      assert.equal(published.headers["cache-control"], "no-store");
      assert.deepEqual((await publish()).json(), published.json());
      assert.deepEqual((await status()).json(), {
        draftRevision: 2,
        publishedRevision: 2,
        canPublish: true,
      });
      const audit = await pool.query(
        `SELECT revision::text,grant_id::text,actor_identity_id::text
           FROM cookie_appearance.publication_audit WHERE tenant_id=$1::uuid`,
        [owner.tenantId],
      );
      assert.deepEqual(audit.rows, [
        { revision: "2", grant_id: activeGrant, actor_identity_id: ownerId },
      ]);
      const newer = await app.inject({
        method: "PUT",
        url,
        headers,
        payload: { expectedRevision: 2, config: createBrandConfig("ocean") },
      });
      assert.equal(newer.statusCode, 200);
      const publishNewer = () =>
        app.inject({
          method: "POST",
          url: prefix + "/publish",
          headers,
          payload: { expectedRevision: 3 },
        });
      await pool.query(
        `UPDATE cookie_entitlement.staging_appearance_grants
            SET revoked_at=clock_timestamp() WHERE tenant_id=$1::uuid`,
        [owner.tenantId],
      );
      assert.equal((await publishNewer()).statusCode, 409);
      assert.deepEqual((await status()).json(), {
        draftRevision: 3,
        publishedRevision: 2,
        canPublish: false,
      });
      const persisted = await pool.query(
        `SELECT draft_revision::text,published_revision::text
           FROM cookie_appearance.organization_branding WHERE tenant_id=$1::uuid`,
        [owner.tenantId],
      );
      assert.deepEqual(persisted.rows, [
        { draft_revision: "3", published_revision: "2" },
      ]);
      const foreign = await app.inject({
        method: "GET",
        url: "/v1/organizations/" + randomUUID() + "/appearance/draft",
        headers,
      });
      assert.equal(foreign.statusCode, 403);
      await pool.query(
        `UPDATE cookie_identity.roles
            SET permissions=array_remove(permissions, 'appearance.publish')
          WHERE tenant_id=$1::uuid`,
        [owner.tenantId],
      );
      assert.equal((await publish()).statusCode, 403);
      assert.equal((await read()).statusCode, 200);
      await pool.query(
        `UPDATE cookie_identity.roles
            SET permissions=array_remove(permissions, 'appearance.manage')
          WHERE tenant_id=$1::uuid`,
        [owner.tenantId],
      );
      assert.equal((await upload(raw)).statusCode, 403);
      assert.equal(
        (await app.inject({ method: "GET", url: capability, headers }))
          .statusCode,
        403,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: assetUrl, headers }))
          .statusCode,
        200,
      );
      await app.inject({ method: "POST", url: "/v1/auth/logout", headers });
      assert.equal(
        (await app.inject({ method: "GET", url: assetUrl, headers }))
          .statusCode,
        401,
      );
      assert.equal((await read()).statusCode, 401);
    } finally {
      await draftOnly.close();
      await disabled.close();
      await app.close();
      await pool.end();
    }
  },
);
