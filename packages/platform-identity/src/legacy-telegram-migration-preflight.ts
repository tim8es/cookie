import type { PoolClient } from "pg";
import type { TelegramMiniAppProofVerifier } from "./telegram-init-data.js";
import { lockTelegramUser } from "./telegram-links.js";

export type LegacyTelegramPreflightResult =
  | "invalid-proof"
  | "no-legacy-link"
  | "ambiguous-legacy-history"
  | "inactive-or-unverified"
  | "global-link-conflict"
  | "other-legacy-link"
  | "additional-memberships"
  | "candidate-for-review";

interface AssessmentRow {
  legacy_count: number;
  eligible_count: number;
  global_conflict: boolean;
  other_legacy: boolean;
  membership_count: number;
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
            WHERE m.identity_id IN (SELECT identity_id FROM legacy)) AS membership_count`,
      [fingerprint],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Migration assessment unavailable");
    if (row.legacy_count === 0) return "no-legacy-link";
    if (row.legacy_count !== 1) return "ambiguous-legacy-history";
    if (row.eligible_count !== 1) return "inactive-or-unverified";
    if (row.global_conflict) return "global-link-conflict";
    if (row.other_legacy) return "other-legacy-link";
    // An account with other memberships needs an explicit scope review.
    if (row.membership_count !== 1) return "additional-memberships";
    return "candidate-for-review";
  });
}
