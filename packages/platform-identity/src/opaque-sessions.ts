import { createHash, randomBytes } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { OpaqueSessionAuthority } from "./authorization.js";

import type {
  TelegramMiniAppProofVerifier,
  VerifiedTelegramMiniAppProof,
} from "./telegram-init-data.js";
import { lockTelegramUser } from "./telegram-links.js";

/**
 * Tenant-scoped F1 session store: Telegram proof ≠ Identity ≠ Cookie session.
 * Runtime registration is explicit and remains separate from global Identity auth.
 */
export interface LinkedIdentity {
  readonly tenantId: string;
  readonly identityId: string;
  /** Present for DB-resolved links; only the legacy synthetic callback may omit it. */
  readonly telegramLinkId?: string;
}

/**
 * Mandatory server-owned account link lookup. Implementations must resolve
 * a previously trusted, consented channel↔Identity link, not client JSON.
 * A bare Telegram ID must NEVER create or link an Identity or Customer.
 */
export type ResolveVerifiedTelegramLink = (
  client: PoolClient,
  proof: VerifiedTelegramMiniAppProof,
) => Promise<LinkedIdentity | null>;

export interface OpaqueTelegramSessionDependencies {
  readonly pool: Pool;
  readonly telegramProofVerifier: TelegramMiniAppProofVerifier;
  /** Shared HMAC key for serializing legacy and global Telegram auth paths. */
  readonly fingerprintSecret: Buffer;
  readonly resolveVerifiedTelegramLink: ResolveVerifiedTelegramLink;
  /** Exact server-authenticated values, not values from browser requests. */
  readonly issuer: string;
  readonly audience: string;
  /** Explicit proposed F1 bound: 60s–3600s, no implicit production default. */
  readonly ttlSeconds: number;
}

export interface IssuedCookieSession {
  /** Return only over an approved secure credential channel, NEVER a URL. */
  readonly bearerToken: string;
  readonly expiresAtUnixSeconds: number;
}

export interface ResolvedCookieSession {
  readonly tenantId: string;
  readonly identityId: string;
  readonly expiresAtUnixSeconds: number;
  readonly opaqueSessionAuthority: OpaqueSessionAuthority;
}

interface SessionRow extends QueryResultRow {
  tenant_id: string;
  identity_id: string;
  expires_at: Date;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BEARER = /^cs_[A-Za-z0-9_-]{43}$/;
const LABEL = /^[a-zA-Z0-9._:/-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/i;

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export class PostgresOpaqueTelegramSessions {
  private readonly fingerprintSecret: Buffer;

  constructor(private readonly deps: OpaqueTelegramSessionDependencies) {
    if (
      !deps?.pool ||
      typeof deps.telegramProofVerifier?.verify !== "function" ||
      !Buffer.isBuffer(deps.fingerprintSecret) ||
      deps.fingerprintSecret.byteLength < 32 ||
      typeof deps.resolveVerifiedTelegramLink !== "function" ||
      !LABEL.test(deps.issuer) ||
      !LABEL.test(deps.audience) ||
      !Number.isSafeInteger(deps.ttlSeconds) ||
      deps.ttlSeconds < 60 ||
      deps.ttlSeconds > 3_600
    ) {
      throw new Error("Invalid opaque session provider configuration");
    }
    this.fingerprintSecret = Buffer.from(deps.fingerprintSecret);
  }

  /**
   * Test-only one-time Telegram proof exchange:
   * 1. Verify bot-owned HMAC/freshness, without inferring tenant.
   * 2. Resolve an EXISTING trusted channel link inside a DB transaction.
   * 3. Require a currently active tenant membership under a SHARE lock.
   * 4. Persist only a SHA-256 of a CSPRNG token; consume Telegram HMAC once.
   *
   * No direct public endpoint, Cookie↔Customer link, cookies or sessions are
   * enabled until F1 #18/#66 authorization and production policies are signed.
   */
  async exchangeTelegramInitData(
    rawInitData: unknown,
  ): Promise<IssuedCookieSession | null> {
    const proof = this.deps.telegramProofVerifier.verify(rawInitData);
    if (!proof || typeof rawInitData !== "string") return null;

    // The verifier has already authenticated this HMAC. Its value (not the
    // reorderable raw query string) is the canonical one-time exchange key.
    const telegramHash = new URLSearchParams(rawInitData).get("hash");
    if (!telegramHash || !HASH.test(telegramHash)) return null;
    const exchangeDigest = createHash("sha256")
      .update("telegram-initdata-exchange-v1\0", "utf8")
      .update(telegramHash.toLowerCase(), "utf8")
      .digest();

    const client = await this.deps.pool.connect();
    let active = false;
    try {
      await client.query("BEGIN");
      active = true;
      const telegramFingerprint = await lockTelegramUser(
        client,
        this.fingerprintSecret,
        proof.telegramUserId,
      );
      const currentProof = this.deps.telegramProofVerifier.verify(rawInitData);
      if (
        !currentProof ||
        currentProof.channel !== proof.channel ||
        currentProof.telegramUserId !== proof.telegramUserId ||
        currentProof.authDateUnixSeconds !== proof.authDateUnixSeconds
      ) {
        await client.query("ROLLBACK");
        active = false;
        return null;
      }
      const globalIdentity = await client.query(
        `SELECT 1 FROM cookie_identity.global_telegram_identities
         WHERE telegram_user_hmac_sha256=$1::bytea FOR SHARE`,
        [telegramFingerprint],
      );
      const globalExchange = await client.query(
        `SELECT 1 FROM cookie_identity.global_telegram_exchanges
         WHERE proof_sha256=$1::bytea FOR SHARE`,
        [exchangeDigest],
      );
      if (globalIdentity.rowCount || globalExchange.rowCount) {
        await client.query("ROLLBACK");
        active = false;
        return null;
      }
      const linked = await this.deps.resolveVerifiedTelegramLink(
        client,
        currentProof,
      );
      if (
        !linked ||
        !UUID.test(linked.tenantId) ||
        !UUID.test(linked.identityId)
      ) {
        await client.query("ROLLBACK");
        active = false;
        return null;
      }
      const member = await client.query(
        `SELECT identity_id FROM cookie_identity.memberships
           WHERE tenant_id=$1::uuid AND identity_id=$2::uuid AND active
           FOR SHARE`,
        [linked.tenantId, linked.identityId],
      );
      if (member.rowCount !== 1) {
        await client.query("ROLLBACK");
        active = false;
        return null;
      }

      // The production-candidate resolver binds a real consented link. The
      // old opt-in synthetic test callback may still omit its link ID.
      if (linked.telegramLinkId !== undefined) {
        if (!UUID.test(linked.telegramLinkId)) {
          await client.query("ROLLBACK");
          active = false;
          return null;
        }
        const allowedLink = await client.query(
          `SELECT id FROM cookie_identity.telegram_identity_links
             WHERE tenant_id=$1::uuid AND identity_id=$2::uuid
               AND id=$3::uuid AND revoked_at IS NULL
             FOR SHARE`,
          [linked.tenantId, linked.identityId, linked.telegramLinkId],
        );
        if (allowedLink.rowCount !== 1) {
          await client.query("ROLLBACK");
          active = false;
          return null;
        }
      }

      const bearerToken = "cs_" + randomBytes(32).toString("base64url");
      const created = await client.query<SessionRow>(
        `INSERT INTO cookie_identity.opaque_sessions
           (token_sha256,telegram_exchange_sha256,tenant_id,identity_id,
            issuer,audience,issued_at,expires_at,telegram_link_id)
         VALUES ($1::bytea,$2::bytea,$3::uuid,$4::uuid,$5,$6,
                 clock_timestamp(),clock_timestamp() + $7::integer * INTERVAL '1 second',
                 $8::uuid)
         ON CONFLICT DO NOTHING
         RETURNING tenant_id::text,identity_id::text,expires_at`,
        [
          tokenDigest(bearerToken),
          exchangeDigest,
          linked.tenantId,
          linked.identityId,
          this.deps.issuer,
          this.deps.audience,
          this.deps.ttlSeconds,
          linked.telegramLinkId ?? null,
        ],
      );
      const receipt = created.rows[0];
      if (!receipt) {
        await client.query("ROLLBACK");
        active = false;
        return null;
      }
      await client.query("COMMIT");
      active = false;
      return {
        bearerToken,
        expiresAtUnixSeconds: Math.floor(receipt.expires_at.getTime() / 1_000),
      };
    } catch (error) {
      if (active) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Structural BearerSessionVerifier implementation for opt-in F1 adapters.
   * A valid token is still subject to separate tenant and resource AuthZ.
   */
  async verifyBearerToken(
    bearerToken: string,
  ): Promise<ResolvedCookieSession | null> {
    if (typeof bearerToken !== "string" || !BEARER.test(bearerToken))
      return null;
    const result = await this.deps.pool.query<SessionRow>(
      `SELECT s.tenant_id::text AS tenant_id,
              s.identity_id::text AS identity_id,s.expires_at
         FROM cookie_identity.opaque_sessions s
         JOIN cookie_identity.memberships m
           ON m.tenant_id=s.tenant_id AND m.identity_id=s.identity_id
        WHERE s.token_sha256=$1::bytea
          AND s.issuer=$2 AND s.audience=$3
          AND s.revoked_at IS NULL
          AND s.expires_at > clock_timestamp()
          AND m.active
          AND (
            s.telegram_link_id IS NULL
            OR EXISTS (
              SELECT 1 FROM cookie_identity.telegram_identity_links AS link
               WHERE link.tenant_id=s.tenant_id
                 AND link.identity_id=s.identity_id
                 AND link.id=s.telegram_link_id
                 AND link.revoked_at IS NULL
            )
          )`,
      [tokenDigest(bearerToken), this.deps.issuer, this.deps.audience],
    );
    const value = result.rows[0];
    if (
      !value ||
      !UUID.test(value.tenant_id) ||
      !UUID.test(value.identity_id)
    ) {
      return null;
    }
    return {
      tenantId: value.tenant_id,
      identityId: value.identity_id,
      expiresAtUnixSeconds: Math.floor(value.expires_at.getTime() / 1_000),
      opaqueSessionAuthority: {
        tokenSha256: tokenDigest(bearerToken).toString("hex"),
        issuer: this.deps.issuer,
        audience: this.deps.audience,
      },
    };
  }

  /** Bearer possession is sufficient to revoke that exact session only. */
  async revokeBearerToken(bearerToken: string): Promise<boolean> {
    if (typeof bearerToken !== "string" || !BEARER.test(bearerToken))
      return false;
    const result = await this.deps.pool.query(
      `UPDATE cookie_identity.opaque_sessions
          SET revoked_at=clock_timestamp()
        WHERE token_sha256=$1::bytea
          AND issuer=$2 AND audience=$3 AND revoked_at IS NULL`,
      [tokenDigest(bearerToken), this.deps.issuer, this.deps.audience],
    );
    return result.rowCount === 1;
  }
}
