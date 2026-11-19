import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { TelegramMiniAppProofVerifier } from "./telegram-init-data.js";
import { lockTelegramUser } from "./telegram-links.js";

export type LegacyTelegramPreflightResult =
  | "invalid-proof"
  | "consumed-proof"
  | "no-legacy-link"
  | "ambiguous-legacy-history"
  | "inactive-or-unverified"
  | "global-link-conflict"
  | "other-legacy-link"
  | "additional-memberships"
  | "existing-email-provider"
  | "role-scope-review"
  | "candidate-for-review";

interface AssessmentRow {
  legacy_count: number;
  eligible_count: number;
  global_conflict: boolean;
  other_legacy: boolean;
  membership_count: number;
  consumed_proof: boolean;
  email_provider: boolean;
  active_role_count: number;
  unsupported_role: boolean;
}

/**
 * Internal, read-only assessment. Not an authentication or migration grant.
 * The trusted caller supplies a real verifier and DB transaction; this port
 * must never be mounted as a public endpoint or consume a proof. No IDs,
 * fingerprints or credentials are returned. An assessment is only a
 * statement-time snapshot, never authority to perform a later mutation.
 */
export async function assessLegacyTelegramMigration(
  transaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>,
  verifier: TelegramMiniAppProofVerifier,
  fingerprintSecret: Buffer,
  rawInitData: unknown,
): Promise<LegacyTelegramPreflightResult> {
  if (
    typeof rawInitData !== "string" ||
    Buffer.byteLength(rawInitData, "utf8") > 8192
  )
    return "invalid-proof";
  const proof = verifier.verify(rawInitData);
  if (!proof || proof.channel !== "telegram-mini-app") return "invalid-proof";
  const hash = new URLSearchParams(rawInitData).get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return "invalid-proof";
  const exchangeHash = createHash("sha256")
    .update("telegram-initdata-exchange-v1\0")
    .update(hash.toLowerCase())
    .digest();
  return transaction(async (client) => {
    const fingerprint = await lockTelegramUser(
      client,
      fingerprintSecret,
      proof.telegramUserId,
    );
    const current = verifier.verify(rawInitData);
    if (
      !current ||
      current.channel !== proof.channel ||
      current.telegramUserId !== proof.telegramUserId ||
      current.authDateUnixSeconds !== proof.authDateUnixSeconds
    )
      return "invalid-proof";

    // One statement, one MVCC snapshot. Historical links are deliberately
    // included; do not pick an arbitrary active row after ignoring history.
    const result = await client.query<AssessmentRow>(
      `WITH legacy AS (
         SELECT tenant_id,identity_id,revoked_at,proof_verified_at,consent_confirmed_at
         FROM cookie_identity.telegram_identity_links
         WHERE telegram_user_hmac_sha256=$1::bytea
       )
       SELECT
         (SELECT count(*)::int FROM legacy) AS legacy_count,
         (SELECT count(*)::int FROM legacy l
            JOIN cookie_identity.memberships m
              ON m.tenant_id=l.tenant_id AND m.identity_id=l.identity_id
            WHERE l.revoked_at IS NULL AND l.proof_verified_at IS NOT NULL
              AND l.consent_confirmed_at IS NOT NULL AND m.active) AS eligible_count,
         EXISTS (
           SELECT 1 FROM cookie_identity.global_telegram_identities g
           WHERE g.telegram_user_hmac_sha256=$1::bytea
             OR g.identity_id IN (SELECT identity_id FROM legacy)
         ) AS global_conflict,
         EXISTS (
           SELECT 1 FROM cookie_identity.telegram_identity_links other
           WHERE other.identity_id IN (SELECT identity_id FROM legacy)
             AND other.telegram_user_hmac_sha256<>$1::bytea
         ) AS other_legacy,
         (SELECT count(*)::int FROM cookie_identity.memberships m
            WHERE m.identity_id IN (SELECT identity_id FROM legacy)) AS membership_count,
         (EXISTS (SELECT 1 FROM cookie_identity.opaque_sessions
             WHERE telegram_exchange_sha256=$2::bytea)
          OR EXISTS (SELECT 1 FROM cookie_identity.global_telegram_exchanges
             WHERE proof_sha256=$2::bytea)) AS consumed_proof,
         EXISTS (SELECT 1 FROM cookie_identity.email_credentials e
            WHERE e.identity_id IN (SELECT identity_id FROM legacy)) AS email_provider,
         (SELECT count(*)::int FROM legacy l
            JOIN cookie_identity.role_assignments a
              ON a.tenant_id=l.tenant_id AND a.identity_id=l.identity_id
            JOIN cookie_identity.roles r
              ON r.tenant_id=a.tenant_id AND r.id=a.role_id
            WHERE a.active AND r.active) AS active_role_count,
         EXISTS (
           SELECT 1 FROM legacy l
           JOIN cookie_identity.role_assignments a
             ON a.tenant_id=l.tenant_id AND a.identity_id=l.identity_id
           JOIN cookie_identity.roles r
             ON r.tenant_id=a.tenant_id AND r.id=a.role_id
           JOIN cookie_tenancy.organizations o ON o.id=l.tenant_id
           WHERE a.active AND r.active AND (
             a.location_id IS NOT NULL OR r.base_type NOT IN ('owner','client')
             OR (r.base_type='owner' AND o.owner_identity_id<>l.identity_id)
           )
         ) AS unsupported_role`,
      [fingerprint, exchangeHash],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Migration assessment unavailable");
    if (row.consumed_proof) return "consumed-proof";
    if (row.legacy_count === 0) return "no-legacy-link";
    if (row.legacy_count !== 1) return "ambiguous-legacy-history";
    if (row.eligible_count !== 1) return "inactive-or-unverified";
    if (row.global_conflict) return "global-link-conflict";
    if (row.other_legacy) return "other-legacy-link";
    // An account with other memberships needs an explicit scope review.
    if (row.membership_count !== 1) return "additional-memberships";
    if (row.email_provider) return "existing-email-provider";
    if (row.active_role_count < 1 || row.unsupported_role)
      return "role-scope-review";
    return "candidate-for-review";
  });
}
