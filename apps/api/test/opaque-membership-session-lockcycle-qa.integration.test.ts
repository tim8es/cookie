import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import { Pool } from "pg";
import type { PoolClient } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { requireTenantPermission } from "../../../packages/platform-identity/src/postgres.js";
import { verifyTenantActor } from "../src/session-context.js";

test(
  "membership-disable trigger and Cookie session guard must not form a PostgreSQL lock cycle",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-opaque-membership-lock-cycle",
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    const tenantId = randomUUID();
    const identityId = randomUUID();
    const roleId = randomUUID();
    const linkId = randomUUID();
    const bearerToken = "cs_" + randomBytes(32).toString("base64url");
    const digest = createHash("sha256").update(bearerToken).digest();
    let guarding: PoolClient | undefined;
    let revoking: PoolClient | undefined;
    let releaseGate: (() => void) | undefined;
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [identityId],
      );
      await pool.query(
        [
          "INSERT INTO cookie_tenancy.organizations",
          "(id,owner_identity_id,display_name)",
          "VALUES($1::uuid,$2::uuid,'Synthetic membership lock-cycle')",
        ].join("\n"),
        [tenantId, identityId],
      );
      await pool.query(
        [
          "INSERT INTO cookie_identity.memberships(tenant_id,identity_id)",
          "VALUES($1::uuid,$2::uuid)",
        ].join("\n"),
        [tenantId, identityId],
      );
      await pool.query(
        [
          "INSERT INTO cookie_identity.roles",
          "(tenant_id,id,base_type,display_name,permissions)",
          "VALUES($1::uuid,$2::uuid,'owner','Synthetic owner',",
          "ARRAY['booking.create'])",
        ].join("\n"),
        [tenantId, roleId],
      );
      await pool.query(
        [
          "INSERT INTO cookie_identity.role_assignments",
          "(tenant_id,id,identity_id,role_id)",
          "VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)",
        ].join("\n"),
        [tenantId, randomUUID(), identityId, roleId],
      );
      await pool.query(
        [
          "INSERT INTO cookie_identity.telegram_identity_links",
          "(tenant_id,id,identity_id,telegram_user_hmac_sha256,",
          "proof_verified_at,consent_confirmed_at)",
          "VALUES($1::uuid,$2::uuid,$3::uuid,$4::bytea,",
          "clock_timestamp(),clock_timestamp())",
        ].join("\n"),
        [tenantId, linkId, identityId, randomBytes(32)],
      );
      await pool.query(
        [
          "INSERT INTO cookie_identity.opaque_sessions",
          "(token_sha256,telegram_exchange_sha256,tenant_id,identity_id,",
          "issuer,audience,issued_at,expires_at,telegram_link_id)",
          "VALUES($1::bytea,$2::bytea,$3::uuid,$4::uuid,",
          "'cookie-qa','booking-qa',clock_timestamp(),",
          "clock_timestamp()+interval '10 minutes',$5::uuid)",
        ].join("\n"),
        [digest, randomBytes(32), tenantId, identityId, linkId],
      );

      const verified = await verifyTenantActor(
        "Bearer " + bearerToken,
        tenantId,
        {
          async verifyBearerToken() {
            return {
              tenantId,
              identityId,
              expiresAtUnixSeconds: Math.floor(Date.now() / 1_000) + 600,
            };
          },
        },
      );
      assert.ok(verified.actor, "synthetic AuthN must supply a trusted actor");

      let reachedSessionLock!: () => void;
      const sessionLockAcquired = new Promise<void>((resolve) => {
        reachedSessionLock = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });

      guarding = await pool.connect();
      revoking = await pool.connect();
      await guarding.query("BEGIN");
      await guarding.query("SET LOCAL statement_timeout='6000ms'");
      await revoking.query("BEGIN");
      await revoking.query("SET LOCAL statement_timeout='6000ms'");

      // Instrument only the SQL execution boundary. This delegates to the
      // REAL PoolClient and records the actual acquired Session SHARE lock.
      // No backend or QA test under review is modified.
      const actualQuery = guarding.query.bind(guarding);
      const instrumented = {
        async query(sql: string, args?: unknown[]) {
          const result = await actualQuery(sql, args);
          if (
            sql.includes("FROM cookie_identity.opaque_sessions") &&
            sql.includes("FOR SHARE")
          ) {
            reachedSessionLock();
            await paused;
          }
          return result;
        },
      } as unknown as PoolClient;
      const commandResult = requireTenantPermission(
        instrumented,
        verified.actor,
        { kind: "organization", tenantId },
        "booking.create",
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      await sessionLockAcquired;

      // The Membership UPDATE holds the membership row and then its existing
      // migration 0022 trigger needs a Session UPDATE lock. Meanwhile this
      // command holds Session SHARE. If it subsequently requests Membership
      // SHARE, PostgreSQL detects the two-transaction deadlock.
      const revokeResult = revoking
        .query(
          [
            "UPDATE cookie_identity.memberships",
            "SET active=false WHERE tenant_id=$1::uuid",
            "AND identity_id=$2::uuid",
          ].join("\n"),
          [tenantId, identityId],
        )
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );

      const guardPid = (
        await guarding.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      const revokePid = (
        await revoking.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      assert.ok(guardPid && revokePid);

      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = await pool.query<{ blocked: boolean }>(
          "SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked",
          [guardPid, revokePid],
        );
        if (status.rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await sleep(20);
      }
      assert.equal(
        blocked,
        true,
        "Membership disable must wait on the guarded authorization transaction",
      );

      if (!releaseGate) throw new Error("Missing session lock gate");
      releaseGate();
      releaseGate = undefined;

      const command = await commandResult;
      if (command.ok) {
        await guarding.query("COMMIT");
      } else {
        await guarding.query("ROLLBACK").catch(() => undefined);
      }
      const revoke = await revokeResult;
      if (revoke.ok) {
        await revoking.query("COMMIT");
      } else {
        await revoking.query("ROLLBACK").catch(() => undefined);
      }

      const errorCode = (
        result: typeof command | typeof revoke,
      ): string | null =>
        result.ok
          ? null
          : String(
              (result.error as { code?: string } | undefined)?.code ??
                "unknown",
            );
      assert.deepEqual(
        [errorCode(command), errorCode(revoke)],
        [null, null],
        "Membership disable and guarded Booking must serialize without SQLSTATE 40P01",
      );
    } finally {
      releaseGate?.();
      if (guarding) {
        await guarding.query("ROLLBACK").catch(() => undefined);
        guarding.release();
      }
      if (revoking) {
        await revoking.query("ROLLBACK").catch(() => undefined);
        revoking.release();
      }
      await pool
        .query(
          "DELETE FROM cookie_identity.authorization_audit WHERE tenant_id=$1",
          [tenantId],
        )
        .catch(() => undefined);
      await pool
        .query(
          "DELETE FROM cookie_identity.opaque_sessions WHERE tenant_id=$1",
          [tenantId],
        )
        .catch(() => undefined);
      await pool
        .query(
          "DELETE FROM cookie_identity.telegram_identity_links WHERE tenant_id=$1",
          [tenantId],
        )
        .catch(() => undefined);
      await pool
        .query(
          "DELETE FROM cookie_identity.role_assignments WHERE tenant_id=$1",
          [tenantId],
        )
        .catch(() => undefined);
      await pool
        .query("DELETE FROM cookie_identity.roles WHERE tenant_id=$1", [
          tenantId,
        ])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM cookie_identity.memberships WHERE tenant_id=$1", [
          tenantId,
        ])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM cookie_tenancy.organizations WHERE id=$1", [
          tenantId,
        ])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM cookie_identity.identities WHERE id=$1", [
          identityId,
        ])
        .catch(() => undefined);
      await pool.end();
    }
  },
);
