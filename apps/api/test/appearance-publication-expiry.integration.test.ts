import assert from "node:assert/strict";
import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";

import { Pool } from "pg";

import { createBrandConfig } from "../../../packages/domain-appearance/src/index.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import {
  createPostgresVerifiedTelegramLinkResolver,
  createTelegramMiniAppProofVerifier,
  PostgresOpaqueTelegramSessions,
} from "../../../packages/platform-identity/src/index.js";
import { linkVerifiedTelegramOwner } from "../../../packages/platform-identity/src/link-telegram-owner.js";
import { provisionOwnerWorkspace } from "../../../packages/platform-identity/src/provision-owner-workspace.js";
import { createApp } from "../src/app.js";
import { registerRealAppearanceRoutes } from "../src/appearance-http.js";

const BOT = "123456789:synthetic_appearance_expiry_not_real";
const SECRET = randomBytes(32);
const APP = "cookie-appearance-publish-expiry";

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
  "appearance grant expiry during publication rolls back revision and audit",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: APP,
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
    const app = createApp(pool, { telegramAuthRoutes: { sessions } });
    registerRealAppearanceRoutes(app, {
      pool,
      verifier: sessions,
      stagingPublicationEnabled: true,
    });
    let tenantId: string | undefined;
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const ownerId = randomUUID();
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [ownerId],
      );
      const owner = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: ownerId,
        organizationName: "Synthetic appearance expiry",
        locationName: "Central",
        timeZone: "UTC",
        idempotencyKey: randomUUID(),
      });
      tenantId = owner.tenantId;
      const tenant = owner.tenantId;
      const proof = signedProof();
      await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: tenant,
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
      const root = "/v1/organizations/" + tenant + "/appearance";
      const save = (expectedRevision: number, config: unknown) =>
        app.inject({
          method: "PUT",
          url: root + "/draft",
          headers,
          payload: { expectedRevision, config },
        });
      const publish = (expectedRevision: number) =>
        app.inject({
          method: "POST",
          url: root + "/publish",
          headers,
          payload: { expectedRevision },
        });
      const grantId = randomUUID();
      await pool.query(
        `INSERT INTO cookie_entitlement.staging_appearance_grants
           (tenant_id,id,expires_at)
         VALUES($1::uuid,$2::uuid,clock_timestamp()+interval '1 hour')`,
        [tenant, grantId],
      );
      const firstDraft = await save(0, createBrandConfig("forest"));
      assert.equal(firstDraft.statusCode, 200);
      const original = await publish(1);
      assert.equal(original.statusCode, 200);
      const secondDraft = await save(1, createBrandConfig("ocean"));
      assert.equal(secondDraft.statusCode, 200);
      const snapshot = async () => ({
        branding: (
          await pool.query(
            `SELECT draft_revision::text,draft_config,published_revision::text,
                    published_config,published_at,updated_at
               FROM cookie_appearance.organization_branding
              WHERE tenant_id=$1::uuid`,
            [tenant],
          )
        ).rows,
        audit: (
          await pool.query(
            `SELECT revision::text,grant_id::text,actor_identity_id::text,
                    correlation_id,published_at
               FROM cookie_appearance.publication_audit
              WHERE tenant_id=$1::uuid ORDER BY revision`,
            [tenant],
          )
        ).rows,
      });
      const before = await snapshot();
      assert.equal(before.audit.length, 1);
      assert.equal(before.branding[0].published_revision, "1");
      assert.equal(before.branding[0].draft_revision, "2");

      const holder = await pool.connect();
      let pending: ReturnType<typeof publish> | undefined;
      try {
        await holder.query("BEGIN");
        const pid = (
          await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0]!.pid;
        assert.equal(
          (
            await holder.query(
              `SELECT tenant_id FROM cookie_appearance.organization_branding
                WHERE tenant_id=$1::uuid FOR UPDATE`,
              [tenant],
            )
          ).rowCount,
          1,
        );
        // The command must observe a live grant before waiting on branding.
        // Wait for actual DB expiry, not a guessed amount of elapsed app time.
        await pool.query(
          `UPDATE cookie_entitlement.staging_appearance_grants
              SET expires_at=clock_timestamp()+interval '8 seconds'
            WHERE tenant_id=$1::uuid`,
          [tenant],
        );
        pending = publish(2);
        void pending.catch(() => undefined);
        const deadline = Date.now() + 6000;
        let blocked = false;
        while (Date.now() < deadline) {
          const observed = await pool.query<{ blocked: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
                WHERE application_name=$2
                  AND $1::int=ANY(pg_blocking_pids(pid))
             ) AS blocked`,
            [pid, APP],
          );
          if (observed.rows[0]?.blocked) {
            blocked = true;
            break;
          }
          await pause(20);
        }
        assert.equal(blocked, true, "Publication never reached branding lock");
        const expiryDeadline = Date.now() + 12000;
        let expired = false;
        while (Date.now() < expiryDeadline) {
          const time = await pool.query<{ expired: boolean }>(
            `SELECT expires_at<=clock_timestamp() AS expired
               FROM cookie_entitlement.staging_appearance_grants
              WHERE tenant_id=$1::uuid`,
            [tenant],
          );
          if (time.rows[0]?.expired) {
            expired = true;
            break;
          }
          await pause(50);
        }
        assert.equal(expired, true, "Grant did not expire on DB clock");
        assert.deepEqual(await snapshot(), before);
      } finally {
        try {
          await holder.query("ROLLBACK");
        } finally {
          holder.release();
          await pending?.catch(() => undefined);
        }
      }
      assert.ok(pending);
      const denied = await pending;
      assert.equal(denied.statusCode, 409);
      assert.deepEqual(denied.json(), {
        error: "appearance-grant-unavailable",
      });
      assert.equal(denied.headers["cache-control"], "no-store");
      assert.deepEqual(await snapshot(), before);

      // Synthetic operator fixture renewal, not an owner/API capability.
      await pool.query(
        `UPDATE cookie_entitlement.staging_appearance_grants
            SET expires_at=clock_timestamp()+interval '1 hour'
          WHERE tenant_id=$1::uuid`,
        [tenant],
      );
      const retried = await publish(2);
      assert.equal(retried.statusCode, 200);
      assert.equal(retried.json().published.revision, 2);
      const after = await snapshot();
      assert.equal(after.branding[0].published_revision, "2");
      assert.deepEqual(after.audit[0], before.audit[0]);
      assert.equal(after.audit.length, 2);
      assert.equal(after.audit[1].grant_id, grantId);
      assert.equal(after.audit[1].actor_identity_id, ownerId);
      assert.deepEqual((await publish(2)).json(), retried.json());
      assert.deepEqual(await snapshot(), after);
    } finally {
      try {
        await app.close();
        if (tenantId) {
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
