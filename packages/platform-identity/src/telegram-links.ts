import { createHmac } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";

import type {
  LinkedIdentity,
  ResolveVerifiedTelegramLink,
} from "./opaque-sessions.js";

/**
 * Server-only resolver for an EXISTING verified, consented channel link.
 * Never create an Identity, Membership, Customer or link from initData.
 */
export interface TrustedTelegramLinkResolverConfig {
  /** Stable independent 256-bit (or stronger) secret PER BOT, not a browser value. */
  readonly userHashSecret: Buffer;
}

interface LinkRow extends QueryResultRow {
  tenant_id: string;
  identity_id: string;
  id: string;
}

const TELEGRAM_ID = /^[1-9][0-9]{0,15}$/;
const FINGERPRINT_CONTEXT = "cookie-telegram-user-fingerprint-v1\0";

/** Deliberately not exported: provisioning requires a separate approved flow. */
function fingerprint(userHashSecret: Buffer, telegramUserId: string): Buffer {
  return createHmac("sha256", userHashSecret)
    .update(FINGERPRINT_CONTEXT, "utf8")
    .update(telegramUserId, "utf8")
    .digest();
}

export function createPostgresVerifiedTelegramLinkResolver(
  config: TrustedTelegramLinkResolverConfig,
): ResolveVerifiedTelegramLink {
  if (
    !Buffer.isBuffer(config?.userHashSecret) ||
    config.userHashSecret.byteLength < 32
  ) {
    throw new Error("Telegram channel link needs a server-only 256-bit secret");
  }
  // Clone; caller mutation after construction must never change identity lookup.
  const secret = Buffer.from(config.userHashSecret);

  return async (client: PoolClient, proof): Promise<LinkedIdentity | null> => {
    if (
      proof?.channel !== "telegram-mini-app" ||
      !TELEGRAM_ID.test(proof.telegramUserId) ||
      !Number.isSafeInteger(Number(proof.telegramUserId))
    ) {
      return null;
    }

    const hash = fingerprint(secret, proof.telegramUserId);
    // Never choose the first of multiple tenants. An approved, explicit
    // tenant-selection protocol is required to support shared Telegram users.
    // SHARE protects the link from concurrent revocation until COMMIT when
    // called inside the opaque-session exchange transaction.
    const result = await client.query<LinkRow>(
      `SELECT tenant_id::text, identity_id::text, id::text
         FROM cookie_identity.telegram_identity_links
        WHERE telegram_user_hmac_sha256=$1::bytea AND revoked_at IS NULL
          AND proof_verified_at IS NOT NULL
          AND consent_confirmed_at IS NOT NULL
        ORDER BY tenant_id, id
        LIMIT 2 FOR SHARE`,
      [hash],
    );
    if (result.rows.length !== 1) return null;
    const link = result.rows[0];
    if (!link) return null;
    return {
      tenantId: link.tenant_id,
      identityId: link.identity_id,
      telegramLinkId: link.id,
    };
  };
}
