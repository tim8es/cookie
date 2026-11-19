import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL = /^[a-zA-Z0-9._:/-]{1,128}$/;
const TOKEN = /^ir_[A-Za-z0-9_-]{43}$/;

interface Policy {
  readonly idleSeconds: number;
  readonly absoluteSeconds: number;
}
interface Credential {
  readonly refreshToken: string;
  readonly expiresAtUnixSeconds: number;
}
type Rotation =
  | { readonly status: "denied" | "replayed" }
  | ({ readonly status: "rotated"; readonly identityId: string } & Credential);

function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function newToken(): string {
  return "ir_" + randomBytes(32).toString("base64url");
}

function expiry(value: Date | undefined): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error("Refresh expiry unavailable");
  return Math.floor(value.getTime() / 1000);
}

/**
 * Internal storage primitive only. No HTTP handler, package entrypoint export,
 * access-token issuance or bearer-to-refresh conversion. Only a future trusted
 * fresh-login continuation may create a family. Before issuing access on refresh,
 * the future integration must revalidate provider authority in the SAME
 * transaction and serialize recovery, provider removal and family revocation.
 *
 * Strict replay policy is a candidate: reuse revokes the family, including
 * concurrent reuse by the same browser. Client coordination is mandatory
 * before activation. No grace window or stored plaintext token.
 */
export class RefreshSessionFamilies {
  private readonly idleSeconds: number;
  private readonly absoluteSeconds: number;

  constructor(
    private readonly transaction: Transaction,
    private readonly issuer: string,
    private readonly audience: string,
    policy: Policy,
  ) {
    if (
      typeof transaction !== "function" ||
      typeof issuer !== "string" ||
      !LABEL.test(issuer) ||
      typeof audience !== "string" ||
      !LABEL.test(audience) ||
      !Number.isSafeInteger(policy?.idleSeconds) ||
      !Number.isSafeInteger(policy?.absoluteSeconds) ||
      policy.idleSeconds < 60 ||
      policy.absoluteSeconds < policy.idleSeconds ||
      policy.absoluteSeconds > 31536000
    )
      throw new Error("Invalid refresh session policy");
    this.idleSeconds = policy.idleSeconds;
    this.absoluteSeconds = policy.absoluteSeconds;
  }

  async createForVerifiedIdentity(identityId: string): Promise<Credential> {
    if (typeof identityId !== "string" || !UUID.test(identityId))
      throw new Error("Invalid identity");
    const familyId = randomUUID();
    const token = newToken();
    return this.transaction(async (client) => {
      const family = await client.query<{ idle_expires_at: Date }>(
        `WITH instant AS (SELECT clock_timestamp() AS ts)
         INSERT INTO cookie_identity.refresh_session_families
         (id,identity_id,issuer,audience,created_at,idle_seconds,
          idle_expires_at,absolute_expires_at)
         SELECT $1::uuid,$2::uuid,$3,$4,ts,$5::integer,
           ts+$5::integer*interval '1 second',
           ts+$6::integer*interval '1 second'
         FROM instant RETURNING idle_expires_at`,
        [
          familyId,
          identityId,
          this.issuer,
          this.audience,
          this.idleSeconds,
          this.absoluteSeconds,
        ],
      );
      await client.query(
        `INSERT INTO cookie_identity.refresh_session_credentials
         (token_sha256,family_id,generation,issued_at)
         VALUES($1::bytea,$2::uuid,0,clock_timestamp())`,
        [digest(token), familyId],
      );
      return {
        refreshToken: token,
        expiresAtUnixSeconds: expiry(family.rows[0]?.idle_expires_at),
      };
    });
  }

  private async lockFamily(client: PoolClient, hash: Buffer) {
    const result = await client.query<{
      id: string;
      identity_id: string;
    }>(
      `SELECT f.id::text,f.identity_id::text
       FROM cookie_identity.refresh_session_families f
       JOIN cookie_identity.refresh_session_credentials c ON c.family_id=f.id
       WHERE c.token_sha256=$1::bytea AND f.issuer=$2 AND f.audience=$3
       FOR UPDATE OF f`,
      [hash, this.issuer, this.audience],
    );
    return result.rows[0];
  }

  async rotate(token: unknown): Promise<Rotation> {
    if (typeof token !== "string" || !TOKEN.test(token))
      return { status: "denied" };
    const hash = digest(token);
    return this.transaction<Rotation>(async (client) => {
      const family = await this.lockFamily(client, hash);
      if (!family) return { status: "denied" };
      // Re-read AFTER the family lock. A token join snapshot from before a
      // concurrent rotation cannot be used to decide whether it was consumed.
      const current = await client.query<{
        generation: number;
        consumed_at: Date | null;
        live: boolean;
        family_generation: number;
      }>(
        `SELECT c.generation,c.consumed_at,f.generation AS family_generation,
           (f.revoked_at IS NULL AND f.idle_expires_at>clock_timestamp()
            AND f.absolute_expires_at>clock_timestamp()) AS live
         FROM cookie_identity.refresh_session_credentials c
         JOIN cookie_identity.refresh_session_families f ON f.id=c.family_id
         WHERE c.token_sha256=$1::bytea AND f.id=$2::uuid`,
        [hash, family.id],
      );
      const row = current.rows[0];
      if (!row?.live) return { status: "denied" };
      if (row.consumed_at !== null || row.generation !== row.family_generation) {
        await client.query(
          `UPDATE cookie_identity.refresh_session_families
           SET revoked_at=clock_timestamp() WHERE id=$1::uuid AND revoked_at IS NULL`,
          [family.id],
        );
        return { status: "replayed" };
      }
      const updated = await client.query<{
        generation: number;
        idle_expires_at: Date;
      }>(
        `WITH instant AS (SELECT clock_timestamp() AS ts)
         UPDATE cookie_identity.refresh_session_families f
         SET generation=f.generation+1,
             idle_expires_at=LEAST(f.absolute_expires_at,
               instant.ts+f.idle_seconds*interval '1 second')
         FROM instant WHERE f.id=$1::uuid AND f.revoked_at IS NULL
           AND f.idle_expires_at>instant.ts AND f.absolute_expires_at>instant.ts
         RETURNING f.generation,f.idle_expires_at`,
        [family.id],
      );
      const next = updated.rows[0];
      if (!next) return { status: "denied" };
      const consumed = await client.query(
        `UPDATE cookie_identity.refresh_session_credentials
         SET consumed_at=clock_timestamp()
         WHERE token_sha256=$1::bytea AND consumed_at IS NULL`,
        [hash],
      );
      if (consumed.rowCount !== 1) throw new Error("Refresh rotation conflict");
      const refreshToken = newToken();
      await client.query(
        `INSERT INTO cookie_identity.refresh_session_credentials
         (token_sha256,family_id,generation,issued_at)
         VALUES($1::bytea,$2::uuid,$3::integer,clock_timestamp())`,
        [digest(refreshToken), family.id, next.generation],
      );
      return {
        status: "rotated",
        identityId: family.identity_id,
        refreshToken,
        expiresAtUnixSeconds: expiry(next.idle_expires_at),
      };
    });
  }

  /** Logout by any known family credential, including one already rotated. */
  async revoke(token: unknown): Promise<void> {
    if (typeof token !== "string" || !TOKEN.test(token)) return;
    const hash = digest(token);
    await this.transaction(async (client) => {
      const family = await this.lockFamily(client, hash);
      if (!family) return;
      await client.query(
        `UPDATE cookie_identity.refresh_session_families
         SET revoked_at=clock_timestamp() WHERE id=$1::uuid AND revoked_at IS NULL`,
        [family.id],
      );
    });
  }
}
