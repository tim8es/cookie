import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL = /^[a-zA-Z0-9._:/-]{1,128}$/;
const TOKEN = /^is_[A-Za-z0-9_-]{43}$/;

function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Internal only: callers must verify credentials and resolve Identity before issuing. */
export class IdentitySessions {
  constructor(
    private readonly pool: Pool,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly ttlSeconds: number,
  ) {
    if (
      !pool ||
      typeof issuer !== "string" ||
      !LABEL.test(issuer) ||
      typeof audience !== "string" ||
      !LABEL.test(audience) ||
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 60 ||
      ttlSeconds > 3600
    ) {
      throw new Error("Invalid identity session configuration");
    }
  }

  async issueForVerifiedIdentity(
    identityId: string,
  ): Promise<{ token: string; expiresAtUnixSeconds: number }> {
    return this.issueWith(this.pool, identityId);
  }

  /** The caller must commit before exposing the returned token. */
  async issueForVerifiedIdentityInTransaction(
    client: PoolClient,
    identityId: string,
  ): Promise<{ token: string; expiresAtUnixSeconds: number }> {
    return this.issueWith(client, identityId);
  }

  private async issueWith(
    database: Pick<PoolClient, "query">,
    identityId: string,
  ): Promise<{ token: string; expiresAtUnixSeconds: number }> {
    if (typeof identityId !== "string" || !UUID.test(identityId))
      throw new Error("Invalid identity");
    const token = "is_" + randomBytes(32).toString("base64url");
    const result = await database.query<{ expires_at: Date }>(
      `INSERT INTO cookie_identity.identity_sessions
       (token_sha256,identity_id,issuer,audience,issued_at,expires_at)
       VALUES($1,$2::uuid,$3,$4,clock_timestamp(),clock_timestamp()+$5::integer*interval '1 second')
       RETURNING expires_at`,
      [digest(token), identityId, this.issuer, this.audience, this.ttlSeconds],
    );
    const expires = result.rows[0]?.expires_at;
    if (!(expires instanceof Date) || !Number.isFinite(expires.getTime())) {
      throw new Error("Identity session creation failed");
    }
    return {
      token,
      expiresAtUnixSeconds: Math.floor(expires.getTime() / 1000),
    };
  }

  async resolve(token: unknown): Promise<string | null> {
    return (await this.resolveWithExpiry(token))?.identityId ?? null;
  }

  async resolveWithExpiry(
    token: unknown,
  ): Promise<{ identityId: string; expiresAtUnixSeconds: number } | null> {
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const result = await this.pool.query<{
      identity_id: string;
      expires_at: Date;
    }>(
      `SELECT identity_id::text,expires_at FROM cookie_identity.identity_sessions
       WHERE token_sha256=$1 AND issuer=$2 AND audience=$3
         AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
      [digest(token), this.issuer, this.audience],
    );
    const row = result.rows[0];
    if (
      !row ||
      !UUID.test(row.identity_id) ||
      !(row.expires_at instanceof Date) ||
      !Number.isFinite(row.expires_at.getTime())
    ) {
      return null;
    }
    return {
      identityId: row.identity_id,
      expiresAtUnixSeconds: Math.floor(row.expires_at.getTime() / 1000),
    };
  }

  /**
   * Resolve a global Identity session for a requested tenant path. The path is
   * only a selection hint; tenant membership and permissions are rechecked
   * under locks by the protected transaction before any data is returned.
   */
  async verifyBearerTokenForTenant(
    token: unknown,
    tenantId: unknown,
  ): Promise<{
    identityId: string;
    tenantId: string;
    expiresAtUnixSeconds: number;
    opaqueSessionAuthority: {
      tokenSha256: string;
      issuer: string;
      audience: string;
      kind: "identity";
    };
  } | null> {
    if (
      typeof token !== "string" ||
      !TOKEN.test(token) ||
      typeof tenantId !== "string" ||
      !UUID.test(tenantId)
    ) {
      return null;
    }
    const result = await this.pool.query<{
      identity_id: string;
      expires_at: Date;
    }>(
      `SELECT identity_id::text,expires_at
       FROM cookie_identity.identity_sessions
       WHERE token_sha256=$1 AND issuer=$2 AND audience=$3
         AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
      [digest(token), this.issuer, this.audience],
    );
    const session = result.rows[0];
    if (
      !session ||
      !UUID.test(session.identity_id) ||
      !(session.expires_at instanceof Date) ||
      !Number.isFinite(session.expires_at.getTime())
    ) {
      return null;
    }
    return {
      identityId: session.identity_id,
      tenantId,
      expiresAtUnixSeconds: Math.floor(session.expires_at.getTime() / 1000),
      opaqueSessionAuthority: {
        tokenSha256: digest(token).toString("hex"),
        issuer: this.issuer,
        audience: this.audience,
        kind: "identity",
      },
    };
  }

  /** Lock one valid Identity session for protected work in the caller transaction. */
  async resolveWithinTransaction(
    client: PoolClient,
    token: unknown,
  ): Promise<string | null> {
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const result = await client.query<{ identity_id: string }>(
      `SELECT identity_id::text FROM cookie_identity.identity_sessions
       WHERE token_sha256=$1 AND issuer=$2 AND audience=$3
         AND revoked_at IS NULL AND expires_at>clock_timestamp()
       FOR SHARE`,
      [digest(token), this.issuer, this.audience],
    );
    return result.rows[0]?.identity_id ?? null;
  }

  /**
   * Candidate for bounded sliding expiry on the same credential.
   * A single conditional UPDATE serializes with existing revocation;
   * neither an expired nor revoked row can become live again.
   * Absolute lifetime is supplied by a reviewed installation policy.
   */
  async renewWithinAbsoluteLifetime(
    token: unknown,
    absoluteLifetimeSeconds: number,
  ): Promise<number | null> {
    if (
      !Number.isSafeInteger(absoluteLifetimeSeconds) ||
      absoluteLifetimeSeconds < this.ttlSeconds ||
      absoluteLifetimeSeconds > 3600
    ) {
      throw new Error("Invalid identity renewal lifetime");
    }
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const result = await this.pool.query<{ expires_at: Date }>(
      `UPDATE cookie_identity.identity_sessions
       SET expires_at=GREATEST(expires_at,LEAST(
         issued_at+$5::integer*interval '1 second',
         clock_timestamp()+$4::integer*interval '1 second'))
       WHERE token_sha256=$1 AND issuer=$2 AND audience=$3
         AND revoked_at IS NULL AND expires_at>clock_timestamp()
         AND refresh_family_id IS NULL
         AND issued_at+$5::integer*interval '1 second'>clock_timestamp()
       RETURNING expires_at`,
      [
        digest(token),
        this.issuer,
        this.audience,
        this.ttlSeconds,
        absoluteLifetimeSeconds,
      ],
    );
    const expiry = result.rows[0]?.expires_at;
    if (!(expiry instanceof Date) || !Number.isFinite(expiry.getTime()))
      return null;
    return Math.floor(expiry.getTime() / 1000);
  }

  async revoke(token: unknown): Promise<void> {
    if (typeof token !== "string" || !TOKEN.test(token)) return;
    await this.pool.query(
      `WITH revoked AS (
         UPDATE cookie_identity.identity_sessions SET revoked_at=clock_timestamp()
         WHERE token_sha256=$1 AND issuer=$2 AND audience=$3 AND revoked_at IS NULL
         RETURNING identity_id
       )
       INSERT INTO cookie_identity.auth_security_events(event_type,identity_id)
       SELECT 'identity_session_revoked',identity_id FROM revoked`,
      [digest(token), this.issuer, this.audience],
    );
  }

  /** Delete expired bearer hashes in a bounded batch. */
  async purgeExpired(batchSize: number): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
      throw new Error("Invalid identity session cleanup batch");
    }
    const result = await this.pool.query(
      `WITH expired AS (
         SELECT token_sha256 FROM cookie_identity.identity_sessions
         WHERE expires_at<=clock_timestamp()
         ORDER BY expires_at,token_sha256 LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM cookie_identity.identity_sessions AS session
       USING expired WHERE session.token_sha256=expired.token_sha256`,
      [batchSize],
    );
    if (result.rowCount === null) {
      throw new Error("Identity session cleanup failed");
    }
    return result.rowCount;
  }
}
