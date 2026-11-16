import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";
import type { PoolClient } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import {
  OpaqueSessionAuthorityDeniedError,
  requireOpaqueSessionCommandAuthority,
  type VerifiedOpaqueBearerCommandAuthority,
} from "../../../packages/platform-identity/src/opaque-session-command-guard.js";

const ISSUER = "cookie-f1-test";
const AUDIENCE = "booking-f1-test";

function token(): string {
  return "cs_" + randomBytes(32).toString("base64url");
}

function authority(
  bearerToken: string,
  tenantId: string,
  identityId: string,
): VerifiedOpaqueBearerCommandAuthority {
  return {
    bearerToken,
    actor: { tenantId, identityId },
    issuer: ISSUER,
    audience: AUDIENCE,
  };
}

async function expectDenied(
  pool: Pool,
  claim: VerifiedOpaqueBearerCommandAuthority,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(
      requireOpaqueSessionCommandAuthority(client, claim),
      OpaqueSessionAuthorityDeniedError,
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

async function expectRevocationBlocked(
  pool: Pool,
  statement: string,
  params: unknown[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '150ms'");
    await assert.rejects(
      client.query(statement, params),
      (error: unknown) =>
        (error as { code?: string }).code === "55P03",
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

test(
  "opaque command authority linearizes bearer, link and membership revocation on PostgreSQL 16",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-opaque-transaction-authority",
      max: 5,
      connectionTimeoutMillis: 5_000,
    });
    const tenantId = randomUUID();
    const identityId = randomUUID();
    const linkId = randomUUID();
    let transaction: PoolClient | undefined;

    async function insertSession(
      bearerToken: string,
      telegramLinkId: string | null,
      expired = false,
    ): Promise<void> {
      const issuedAt = expired
        ? "clock_timestamp()-interval '2 hours'"
        : "clock_timestamp()";
      const expiresAt = expired
        ? "clock_timestamp()-interval '1 hour'"
        : "clock_timestamp()+interval '10 minutes'";
      await pool.query(
        [
          "INSERT INTO cookie_identity.opaque_sessions",
          "(token_sha256,telegram_exchange_sha256,tenant_id,identity_id,",
          "issuer,audience,issued_at,expires_at,telegram_link_id)",
          "VALUES ($1::bytea,$2::bytea,$3::uuid,$4::uuid,$5,$6,",
          issuedAt + "," + expiresAt + ",$7::uuid)",
        ].join("\n"),
        [
          createHash("sha256").update(bearerToken).digest(),
          randomBytes(32),
          tenantId,
          identityId,
          ISSUER,
          AUDIENCE,
          telegramLinkId,
        ],
      );
    }

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1)",
        [identityId],
      );
      await pool.query(
        "INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name) VALUES($1,$2,'Synthetic authority tenant')",
        [tenantId, identityId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.memberships(tenant_id,identity_id) VALUES($1,$2)",
        [tenantId, identityId],
      );
      await pool.query(
        [
          "INSERT INTO cookie_identity.telegram_identity_links",
          "(tenant_id,id,identity_id,telegram_user_hmac_sha256,",
          "proof_verified_at,consent_confirmed_at)",
          "VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp())",
        ].join("\n"),
        [tenantId, linkId, identityId, randomBytes(32)],
      );

      const first = token();
      await insertSession(first, linkId);
      await expectDenied(
        pool,
        authority(first, randomUUID(), identityId),
      );
      await expectDenied(
        pool,
        authority(first, tenantId, randomUUID()),
      );
      await expectDenied(pool, {
        ...authority(first, tenantId, identityId),
        audience: "wrong-audience",
      });
      await expectDenied(pool, authority("bad-token", tenantId, identityId));

      // Command-first: exact bearer UPDATE cannot commit before our
      // transaction releases its session SHARE lock.
      transaction = await pool.connect();
      await transaction.query("BEGIN");
      await requireOpaqueSessionCommandAuthority(
        transaction,
        authority(first, tenantId, identityId),
      );
      await expectRevocationBlocked(
        pool,
        [
          "UPDATE cookie_identity.opaque_sessions",
          "SET revoked_at=clock_timestamp()",
          "WHERE token_sha256=$1::bytea AND revoked_at IS NULL",
        ].join("\n"),
        [createHash("sha256").update(first).digest()],
      );
      await transaction.query("COMMIT");
      transaction.release();
      transaction = undefined;
      await pool.query(
        [
          "UPDATE cookie_identity.opaque_sessions",
          "SET revoked_at=clock_timestamp()",
          "WHERE token_sha256=$1::bytea",
        ].join("\n"),
        [createHash("sha256").update(first).digest()],
      );
      await expectDenied(pool, authority(first, tenantId, identityId));

      // Command-first: link unlink must wait for the lock. Unlink-first:
      // the same bearer is unusable after the revoke transaction commits.
      const second = token();
      await insertSession(second, linkId);
      transaction = await pool.connect();
      await transaction.query("BEGIN");
      await requireOpaqueSessionCommandAuthority(
        transaction,
        authority(second, tenantId, identityId),
      );
      await expectRevocationBlocked(
        pool,
        [
          "UPDATE cookie_identity.telegram_identity_links",
          "SET revoked_at=clock_timestamp()",
          "WHERE tenant_id=$1::uuid AND id=$2::uuid",
        ].join("\n"),
        [tenantId, linkId],
      );
      await transaction.query("COMMIT");
      transaction.release();
      transaction = undefined;
      await pool.query(
        [
          "UPDATE cookie_identity.telegram_identity_links",
          "SET revoked_at=clock_timestamp()",
          "WHERE tenant_id=$1::uuid AND id=$2::uuid",
        ].join("\n"),
        [tenantId, linkId],
      );
      await expectDenied(pool, authority(second, tenantId, identityId));

      const expired = token();
      await insertSession(expired, null, true);
      await expectDenied(pool, authority(expired, tenantId, identityId));

      const third = token();
      await insertSession(third, null);
      transaction = await pool.connect();
      await transaction.query("BEGIN");
      await requireOpaqueSessionCommandAuthority(
        transaction,
        authority(third, tenantId, identityId),
      );
      await expectRevocationBlocked(
        pool,
        [
          "UPDATE cookie_identity.memberships",
          "SET active=false",
          "WHERE tenant_id=$1::uuid AND identity_id=$2::uuid",
        ].join("\n"),
        [tenantId, identityId],
      );
      await transaction.query("COMMIT");
      transaction.release();
      transaction = undefined;
      await pool.query(
        [
          "UPDATE cookie_identity.memberships",
          "SET active=false",
          "WHERE tenant_id=$1::uuid AND identity_id=$2::uuid",
        ].join("\n"),
        [tenantId, identityId],
      );
      await expectDenied(pool, authority(third, tenantId, identityId));
      await pool.query(
        [
          "UPDATE cookie_identity.memberships",
          "SET active=true",
          "WHERE tenant_id=$1::uuid AND identity_id=$2::uuid",
        ].join("\n"),
        [tenantId, identityId],
      );
      await expectDenied(
        pool,
        authority(third, tenantId, identityId),
      );
    } finally {
      if (transaction) {
        await transaction.query("ROLLBACK").catch(() => undefined);
        transaction.release();
      }
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
