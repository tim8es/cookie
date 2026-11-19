import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { TelegramMiniAppProofVerifier } from "./telegram-init-data.js";
import { continueSyntheticTelegramLogin } from "./telegram-self-registration.js";
import { SyntheticRefreshAccessSessions } from "./synthetic-refresh-access-sessions.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
interface Policy {
  readonly idleSeconds: number;
  readonly absoluteSeconds: number;
  readonly accessSeconds: number;
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * Synthetic candidate only. Fresh Mini App login is required; an existing
 * access bearer cannot bootstrap a refresh family. Not a runtime provider.
 */
export class SyntheticTelegramRefresh {
  constructor(
    private readonly transaction: Transaction,
    private readonly verifier: TelegramMiniAppProofVerifier,
    private readonly fingerprintSecret: Buffer,
    private readonly policy: Policy,
  ) {
    this.policy = { ...policy };
  }

  private sessions(client: PoolClient): SyntheticRefreshAccessSessions {
    return new SyntheticRefreshAccessSessions(
      async (work) => work(client),
      this.policy,
    );
  }

  async login(rawInitData: unknown) {
    return continueSyntheticTelegramLogin(
      this.transaction,
      this.verifier,
      this.fingerprintSecret,
      rawInitData,
      async (client, identityId, fingerprint) => {
        const source = await client.query(
          `SELECT 1 FROM cookie_identity.global_telegram_identities
           WHERE telegram_user_hmac_sha256=$1::bytea AND identity_id=$2::uuid
             AND legacy_revoked_at IS NULL FOR SHARE NOWAIT`,
          [fingerprint, identityId],
        );
        if (source.rowCount !== 1)
          throw new Error("Telegram authority unavailable");
        const credentials =
          await this.sessions(client).createForVerifiedIdentity(identityId);
        const bound = await client.query(
          `UPDATE cookie_identity.refresh_session_families f
           SET telegram_provider_fingerprint=$1::bytea
           FROM cookie_identity.refresh_session_credentials c
           WHERE c.token_sha256=$2::bytea AND c.family_id=f.id
             AND f.identity_id=$3::uuid AND f.issuer='cookie-refresh-candidate'
             AND f.audience='synthetic-test' AND f.telegram_provider_fingerprint IS NULL`,
          [fingerprint, digest(credentials.refreshToken), identityId],
        );
        if (bound.rowCount !== 1)
          throw new Error("Telegram refresh source binding failed");
        return credentials;
      },
    );
  }

  async rotate(token: unknown, expectedAccessToken?: string) {
    if (
      typeof token !== "string" ||
      !/^ir_[A-Za-z0-9_-]{43}$/.test(token) ||
      (expectedAccessToken !== undefined &&
        !/^is_[A-Za-z0-9_-]{43}$/.test(expectedAccessToken))
    )
      return { status: "denied" } as const;
    return this.transaction(async (client) => {
      // Lock provider before family. Never wait for a source lock while
      // holding a family lock; source revocation takes the same order.
      const source = await client.query(
        `SELECT g.identity_id
         FROM cookie_identity.refresh_session_credentials c
         JOIN cookie_identity.refresh_session_families f ON f.id=c.family_id
         JOIN cookie_identity.global_telegram_identities g
           ON g.telegram_user_hmac_sha256=f.telegram_provider_fingerprint
           AND g.identity_id=f.identity_id
         WHERE c.token_sha256=$1::bytea AND f.issuer='cookie-refresh-candidate'
           AND f.audience='synthetic-test' AND g.legacy_revoked_at IS NULL
           AND ($2::bytea IS NULL OR EXISTS (
             SELECT 1 FROM cookie_identity.identity_sessions s
             WHERE s.token_sha256=$2::bytea AND s.refresh_family_id=f.id
           ))
         FOR SHARE OF g NOWAIT`,
        [
          digest(token),
          expectedAccessToken ? digest(expectedAccessToken) : null,
        ],
      );
      if (source.rowCount !== 1) return { status: "denied" } as const;
      return this.sessions(client).rotate(token);
    });
  }

  /**
   * A stale access credential is only a family selection check, never a
   * login grant. Logout also requires the exact refresh cookie. It can
   * acknowledge a previously revoked family without revoking another.
   */
  async logout(token: unknown, expectedAccessToken: unknown): Promise<boolean> {
    if (
      typeof token !== "string" ||
      !/^ir_[A-Za-z0-9_-]{43}$/.test(token) ||
      typeof expectedAccessToken !== "string" ||
      !/^is_[A-Za-z0-9_-]{43}$/.test(expectedAccessToken)
    )
      return false;
    return this.transaction(async (client) => {
      const family = await client.query(
        `SELECT f.id
         FROM cookie_identity.refresh_session_credentials c
         JOIN cookie_identity.refresh_session_families f ON f.id=c.family_id
         JOIN cookie_identity.identity_sessions s ON s.refresh_family_id=f.id
         WHERE c.token_sha256=$1::bytea AND s.token_sha256=$2::bytea
           AND f.issuer='cookie-refresh-candidate'
           AND f.audience='synthetic-test' AND f.telegram_provider_fingerprint IS NOT NULL
         FOR UPDATE OF f`,
        [digest(token), digest(expectedAccessToken)],
      );
      if (family.rowCount !== 1) return false;
      await this.sessions(client).revoke(token);
      return true;
    });
  }
}
