import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { RefreshSessionFamilies } from "./refresh-session-families.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
interface Policy {
  readonly idleSeconds: number;
  readonly absoluteSeconds: number;
  readonly accessSeconds: number;
}

const ISSUER = "cookie-refresh-candidate";
const AUDIENCE = "synthetic-test";

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * Synthetic integration candidate ONLY. The fixed issuer/audience are not
 * accepted by runtime providers. Never export or register this service.
 * Real providers require their own fresh-login and recovery/revoke locking.
 */
export class SyntheticRefreshAccessSessions {
  constructor(
    private readonly transaction: Transaction,
    private readonly policy: Policy,
  ) {
    if (
      !Number.isSafeInteger(policy?.accessSeconds) ||
      policy.accessSeconds < 60 ||
      policy.accessSeconds > 3600
    )
      throw new Error("Invalid access lifetime");
    this.policy = { ...policy };
  }

  private families(transaction: Transaction): RefreshSessionFamilies {
    return new RefreshSessionFamilies(
      transaction,
      ISSUER,
      AUDIENCE,
      this.policy,
    );
  }

  private async issueAccess(client: PoolClient, refreshToken: string) {
    const accessToken = "is_" + randomBytes(32).toString("base64url");
    const result = await client.query<{ expires_at: Date }>(
      `WITH instant AS (SELECT clock_timestamp() AS ts)
       INSERT INTO cookie_identity.identity_sessions
         (token_sha256,identity_id,issuer,audience,issued_at,expires_at,refresh_family_id)
       SELECT $1::bytea,f.identity_id,f.issuer,f.audience,ts,
         LEAST(f.idle_expires_at,f.absolute_expires_at,ts+$2::integer*interval '1 second'),f.id
       FROM cookie_identity.refresh_session_families f
       JOIN cookie_identity.refresh_session_credentials c ON c.family_id=f.id
       CROSS JOIN instant
       WHERE c.token_sha256=$3::bytea AND c.consumed_at IS NULL
         AND c.generation=f.generation AND f.revoked_at IS NULL
         AND f.idle_expires_at>ts AND f.absolute_expires_at>ts
         AND f.issuer=$4 AND f.audience=$5
       RETURNING expires_at`,
      [
        digest(accessToken),
        this.policy.accessSeconds,
        digest(refreshToken),
        ISSUER,
        AUDIENCE,
      ],
    );
    const expires = result.rows[0]?.expires_at;
    if (!(expires instanceof Date) || !Number.isFinite(expires.getTime())) {
      throw new Error("Refresh access issuance failed");
    }
    return {
      accessToken,
      accessExpiresAtUnixSeconds: Math.floor(expires.getTime() / 1000),
    };
  }

  async createForVerifiedIdentity(identityId: string) {
    return this.transaction(async (client) => {
      const families = this.families(async (work) => work(client));
      const refresh = await families.createForVerifiedIdentity(identityId);
      const access = await this.issueAccess(client, refresh.refreshToken);
      return { ...refresh, ...access };
    });
  }

  async rotate(refreshToken: unknown) {
    return this.transaction(async (client) => {
      const families = this.families(async (work) => work(client));
      const refresh = await families.rotate(refreshToken);
      if (refresh.status !== "rotated") return refresh;
      const access = await this.issueAccess(client, refresh.refreshToken);
      return { ...refresh, ...access };
    });
  }

  async revoke(refreshToken: unknown): Promise<void> {
    await this.families(this.transaction).revoke(refreshToken);
  }
}
