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
    if (typeof identityId !== "string" || !UUID.test(identityId))
      throw new Error("Invalid identity");
    const token = "is_" + randomBytes(32).toString("base64url");
    const result = await this.pool.query<{ expires_at: Date }>(
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
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const result = await this.pool.query<{ identity_id: string }>(
      `SELECT identity_id::text FROM cookie_identity.identity_sessions
       WHERE token_sha256=$1 AND issuer=$2 AND audience=$3
         AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
      [digest(token), this.issuer, this.audience],
    );
    return result.rows[0]?.identity_id ?? null;
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

  async revoke(token: unknown): Promise<void> {
    if (typeof token !== "string" || !TOKEN.test(token)) return;
    await this.pool.query(
      `UPDATE cookie_identity.identity_sessions SET revoked_at=clock_timestamp()
       WHERE token_sha256=$1 AND issuer=$2 AND audience=$3 AND revoked_at IS NULL`,
      [digest(token), this.issuer, this.audience],
    );
  }
}
