import type { Pool, PoolClient } from "pg";

/**
 * F1-only database maintenance. No HTTP route, cron job or production
 * bootstrap registration is included here.
 *
 * Telegram Mini App verifier accepts proofs for at most 3600 seconds and
 * permits at most 60 seconds of future skew. Retaining consumed HMAC hashes
 * for at least 7200 seconds from issue time prevents a revoked/expired
 * session from reopening a still-valid proof. This bound assumes synchronized
 * verifier and PostgreSQL clocks; see the companion retention document.
 */
const MIN_RETENTION_SECONDS = 7_200;
const MAX_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MAX_BATCH_SIZE = 500;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OpaqueSessionMaintenanceConfig {
  readonly pool: Pool;
  /** Trusted composition root: resolve only after acknowledged COMMIT. */
  readonly runTransaction: <T>(
    pool: Pool,
    work: (client: PoolClient) => Promise<T>,
  ) => Promise<T>;
  /** Explicit minimum age for consumed proof HMAC hashes, from issued_at. */
  readonly retentionSeconds: number;
  /** Maximum number of old sessions to delete in one non-blocking batch. */
  readonly batchSize: number;
}

export interface OpaqueSessionPurgeResult {
  readonly deleted: number;
}

export type InactiveMembershipDeleteResult =
  | { readonly status: "missing" | "active"; readonly deletedSessions: 0 }
  | { readonly status: "retained"; readonly deletedSessions: number }
  | { readonly status: "deleted"; readonly deletedSessions: number }
  | { readonly status: "blocked-by-dependencies"; readonly deletedSessions: 0 };

const RETENTION_CONDITION = [
  "issued_at <= clock_timestamp() - $1::integer * INTERVAL '1 second'",
  "(expires_at <= clock_timestamp() OR revoked_at IS NOT NULL)",
].join(" AND ");

const BATCH_PURGE_SQL = [
  "WITH candidates AS (",
  "  SELECT token_sha256 FROM cookie_identity.opaque_sessions",
  "   WHERE " + RETENTION_CONDITION,
  "   ORDER BY issued_at ASC, token_sha256 ASC",
  "   LIMIT $2::integer FOR UPDATE SKIP LOCKED",
  ")",
  "DELETE FROM cookie_identity.opaque_sessions AS s",
  " USING candidates AS c",
  " WHERE s.token_sha256=c.token_sha256",
].join("\n");

export class PostgresOpaqueSessionMaintenance {
  constructor(private readonly config: OpaqueSessionMaintenanceConfig) {
    if (
      !config?.pool ||
      typeof config.pool.query !== "function" ||
      typeof config.pool.connect !== "function" ||
      typeof config.runTransaction !== "function" ||
      !Number.isSafeInteger(config.retentionSeconds) ||
      config.retentionSeconds < MIN_RETENTION_SECONDS ||
      config.retentionSeconds > MAX_RETENTION_SECONDS ||
      !Number.isSafeInteger(config.batchSize) ||
      config.batchSize < 1 ||
      config.batchSize > MAX_BATCH_SIZE
    ) {
      throw new Error("Invalid opaque session maintenance configuration");
    }
  }

  /**
   * Bounded, opt-in maintenance. SKIP LOCKED avoids stalling the worker on
   * sessions concurrently being issued/revoked. Repeat until deleted=0,
   * but never run as part of an authorization or Booking transaction.
   */
  async purgeBatch(): Promise<OpaqueSessionPurgeResult> {
    const result = await this.config.pool.query(BATCH_PURGE_SQL, [
      this.config.retentionSeconds,
      this.config.batchSize,
    ]);
    return { deleted: result.rowCount ?? 0 };
  }

  /**
   * Atomic internal-only member removal for a disabled membership with no
   * other dependent records. A membership row lock serializes this operation
   * with Telegram exchange's FOR SHARE check and membership reactivation.
   * A fresh consumed HMAC prevents deletion until its replay window passes.
   *
   * Other platform ownership (e.g. role assignments / trusted channel links)
   * must be handled by the owning module; restrictive FKs cause a safe deny.
   */
  async deleteInactiveMembership(
    tenantId: string,
    identityId: string,
  ): Promise<InactiveMembershipDeleteResult> {
    if (!UUID.test(tenantId) || !UUID.test(identityId)) {
      throw new Error("Invalid tenant or identity UUID");
    }
    try {
      return await this.config.runTransaction<InactiveMembershipDeleteResult>(
        this.config.pool,
        async (client) => {
          const member = await client.query<{ active: boolean }>(
            [
              "SELECT active FROM cookie_identity.memberships",
              " WHERE tenant_id=$1::uuid AND identity_id=$2::uuid FOR UPDATE",
            ].join("\n"),
            [tenantId, identityId],
          );
          if (member.rowCount !== 1) {
            return { status: "missing", deletedSessions: 0 };
          }
          if (member.rows[0]?.active !== false) {
            return { status: "active", deletedSessions: 0 };
          }

          const removed = await this.deleteEligibleForMembership(
            client,
            tenantId,
            identityId,
          );
          const remaining = await client.query(
            [
              "SELECT 1 FROM cookie_identity.opaque_sessions",
              " WHERE tenant_id=$1::uuid AND identity_id=$2::uuid LIMIT 1",
            ].join("\n"),
            [tenantId, identityId],
          );
          if (remaining.rowCount !== 0) {
            return { status: "retained", deletedSessions: removed };
          }

          // Existing restrictive FKs are deliberate. Never cascade silently.
          await client.query(
            [
              "DELETE FROM cookie_identity.memberships",
              " WHERE tenant_id=$1::uuid AND identity_id=$2::uuid AND NOT active",
            ].join("\n"),
            [tenantId, identityId],
          );
          return { status: "deleted", deletedSessions: removed };
        },
      );
    } catch (error) {
      // 23503 = foreign_key_violation: roles / trusted Telegram links etc.
      // The shared transaction port must finish rollback before this result.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23503"
      ) {
        return { status: "blocked-by-dependencies", deletedSessions: 0 };
      }
      throw error;
    }
  }

  private async deleteEligibleForMembership(
    client: PoolClient,
    tenantId: string,
    identityId: string,
  ): Promise<number> {
    const result = await client.query(
      [
        "WITH candidates AS (",
        "  SELECT token_sha256 FROM cookie_identity.opaque_sessions",
        "  WHERE tenant_id=$2::uuid AND identity_id=$3::uuid",
        "    AND " + RETENTION_CONDITION,
        "  ORDER BY issued_at ASC, token_sha256 ASC",
        "  LIMIT $4::integer FOR UPDATE SKIP LOCKED",
        ")",
        "DELETE FROM cookie_identity.opaque_sessions AS s",
        " USING candidates AS c",
        " WHERE s.token_sha256=c.token_sha256",
      ].join("\n"),
      [
        this.config.retentionSeconds,
        tenantId,
        identityId,
        this.config.batchSize,
      ],
    );
    return result.rowCount ?? 0;
  }
}
