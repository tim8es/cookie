import assert from "node:assert/strict";
import { createHash, createHmac, randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { linkVerifiedTelegramOwner } from "../../../packages/platform-identity/src/link-telegram-owner.js";
import {
  createPostgresVerifiedTelegramLinkResolver,
  createTelegramMiniAppProofVerifier,
  PostgresOpaqueTelegramSessions,
} from "../../../packages/platform-identity/src/index.js";
import { provisionOwnerWorkspace } from "../../../packages/platform-identity/src/provision-owner-workspace.js";
import { createApp } from "../src/app.js";
import { registerPrivateAppearanceAssetRoutes } from "../src/appearance-assets-http.js";

const BOT = "123456789:synthetic_revoked_upload_test_only";
const SECRET = Buffer.alloc(32, 0x5a);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
  "base64",
);

function signedProof(userId: number): string {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: randomUUID(),
    user: JSON.stringify({ id: userId, first_name: "Synthetic" }),
  };
  const check = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => name + "=" + value)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

function pausedDecode() {
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    async decode() {
      signalStarted();
      await releasePromise;
      // The actual subprocess codec is tested separately. This synthetic
      // boundary lets real SQL policy changes occur while decoding is paused.
      return { bytes: Buffer.from(PNG), width: 1, height: 1 };
    },
  };
}

async function assertDecodeEntered(started: Promise<void>): Promise<void> {
  await Promise.race([
    started,
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("Private upload did not reach codec boundary")),
        5_000,
      );
    }),
  ]);
}

test(
  "in-flight private Appearance upload fails closed after real role or bearer revoke",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-appearance-revoke-while-decoding",
      max: 6,
    });
    const telegramVerifier = createTelegramMiniAppProofVerifier({
      botToken: BOT,
      maxAgeSeconds: 300,
    });
    const sessions = new PostgresOpaqueTelegramSessions({
      pool,
      fingerprintSecret: SECRET,
      telegramProofVerifier: telegramVerifier,
      resolveVerifiedTelegramLink: createPostgresVerifiedTelegramLinkResolver({
        userHashSecret: SECRET,
      }),
      issuer: "cookie-telegram",
      audience: "cookie-web",
      ttlSeconds: 900,
    });
    const app = createApp(pool, { telegramAuthRoutes: { sessions } });
    let codec: ReturnType<typeof pausedDecode> | null = null;
    const inFlight: Promise<unknown>[] = [];
    registerPrivateAppearanceAssetRoutes(app, {
      pool,
      verifier: sessions,
      quota: { maxAssets: 2, maxBytes: 2 * 1024 * 1024 },
      normalizeImage: async (raw, mime) => {
        assert.deepEqual(raw, PNG);
        assert.equal(mime, "image/png");
        return codec
          ? codec.decode()
          : { bytes: Buffer.from(PNG), width: 1, height: 1 };
      },
    });
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const identityId = randomUUID();
      const userId = randomInt(1_000_000_000, 2_000_000_000);
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [identityId],
      );
      const owner = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: identityId,
        organizationName: "Synthetic revoked upload salon",
        locationName: "Central",
        timeZone: "UTC",
        idempotencyKey: randomUUID(),
      });
      await linkVerifiedTelegramOwner(pool, telegramVerifier, SECRET, {
        tenantId: owner.tenantId,
        ownerIdentityId: identityId,
        rawInitData: signedProof(userId),
        consentConfirmed: true,
      });
      const login = async (): Promise<string> => {
        const response = await app.inject({
          method: "POST",
          url: "/v1/auth/telegram/exchange",
          payload: { initData: signedProof(userId) },
        });
        assert.equal(response.statusCode, 201);
        const token: unknown = response.json().accessToken;
        assert.equal(typeof token, "string");
        return token as string;
      };
      const url = (kind: string) =>
        "/v1/organizations/" + owner.tenantId + "/appearance/assets/" + kind;
      const upload = (kind: string, token: string) =>
        app.inject({
          method: "POST",
          url: url(kind),
          headers: {
            authorization: "Bearer " + token,
            "content-type": "image/png",
          },
          payload: PNG,
        });
      const count = async (): Promise<number> => {
        const result = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM cookie_appearance.assets WHERE tenant_id=$1::uuid",
          [owner.tenantId],
        );
        return result.rows[0]!.count;
      };
      const firstToken = await login();
      assert.equal(await count(), 0);

      // A completed preflight is not lasting authority. Remove the real
      // appearance.manage permission after preflight, while the codec waits.
      codec = pausedDecode();
      const roleGate = codec;
      const roleUpload = upload("logo", firstToken);
      inFlight.push(roleUpload);
      await assertDecodeEntered(roleGate.started);
      const removed = await pool.query(
        `UPDATE cookie_identity.roles
           SET permissions=array_remove(permissions,'appearance.manage')
         WHERE tenant_id=$1::uuid
           AND 'appearance.manage'=ANY(permissions)`,
        [owner.tenantId],
      );
      assert.ok(removed.rowCount && removed.rowCount > 0);
      roleGate.release();
      const forbidden = await roleUpload;
      assert.equal(forbidden.statusCode, 403);
      assert.deepEqual(forbidden.json(), { error: "forbidden" });
      assert.equal(await count(), 0);
      assert.equal(forbidden.headers["cache-control"], "no-store");
      assert.doesNotMatch(forbidden.body, /cs_|Synthetic|iVBOR/);
      codec = null;

      // A later healthy request may still use the same adapter: previous
      // denial must release one-at-a-time upload admission.
      await pool.query(
        `UPDATE cookie_identity.roles
           SET permissions=array_append(permissions,'appearance.manage')
         WHERE tenant_id=$1::uuid
           AND NOT ('appearance.manage'=ANY(permissions))`,
        [owner.tenantId],
      );
      const accepted = await upload("logo", firstToken);
      assert.equal(accepted.statusCode, 200);
      assert.equal(await count(), 1);

      // Revoke the actual PostgreSQL bearer during a second blocked decode.
      // The second upload uses a different kind so an unauthorized commit
      // could not be masked by byte-identical deduplication.
      codec = pausedDecode();
      const sessionGate = codec;
      const revokedUpload = upload("background", firstToken);
      inFlight.push(revokedUpload);
      await assertDecodeEntered(sessionGate.started);
      const bearerSha = createHash("sha256").update(firstToken).digest();
      const revoked = await pool.query(
        `UPDATE cookie_identity.opaque_sessions
           SET revoked_at=clock_timestamp()
         WHERE token_sha256=$1::bytea AND tenant_id=$2::uuid
           AND identity_id=$3::uuid AND revoked_at IS NULL`,
        [bearerSha, owner.tenantId, identityId],
      );
      assert.equal(revoked.rowCount, 1);
      sessionGate.release();
      const unauthorized = await revokedUpload;
      assert.equal(unauthorized.statusCode, 401);
      assert.deepEqual(unauthorized.json(), { error: "unauthorized" });
      assert.equal(unauthorized.headers["cache-control"], "no-store");
      assert.doesNotMatch(unauthorized.body, /cs_|Synthetic|iVBOR/);
      assert.equal(await count(), 1);
      codec = null;

      // A fresh real cryptographic proof creates an independent bearer.
      // No aborted request should permanently consume upload admission.
      const renewedToken = await login();
      assert.notEqual(renewedToken, firstToken);
      const recovered = await upload("background", renewedToken);
      assert.equal(recovered.statusCode, 200);
      assert.equal(await count(), 2);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM cookie_appearance.assets WHERE tenant_id=$1::uuid AND kind='background'",
            [owner.tenantId],
          )
        ).rows[0].count,
        1,
      );
    } finally {
      codec?.release();
      await Promise.allSettled(inFlight);
      await app.close();
      await pool.end();
    }
  },
);
