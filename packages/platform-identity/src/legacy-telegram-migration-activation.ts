import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { appendAuthIdentityAudit } from "./auth-security-audit.js";
import { assessLegacyTelegramMigration } from "./legacy-telegram-migration-preflight.js";
import type { TelegramMiniAppProofVerifier } from "./telegram-init-data.js";
import { lockTelegramUser } from "./telegram-links.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ActivationInput {
  readonly requestId: string;
  readonly rawInitData: string;
  readonly consentConfirmed: true;
}
export type ActivationResult =
  | "invalid-input"
  | "invalid-proof"
  | "target-mismatch"
  | "not-eligible"
  | "activated"
  | "already-activated";

/**
 * Internal F1 synthetic candidate, not exported or registered in runtime.
 * An independently authorized operator must approve the exact preparation.
 * No grant is inferred from a receipt, consent flag or browser input alone.
 * No bearer is issued by migration; a separately fresh login is required.
 */
export async function activateLegacyTelegramMigration(
  transaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>,
  verifier: TelegramMiniAppProofVerifier,
  fingerprintSecret: Buffer,
  input: ActivationInput,
): Promise<ActivationResult> {
  if (
    !input ||
    !UUID.test(input.requestId) ||
    input.consentConfirmed !== true ||
    typeof input.rawInitData !== "string" ||
    Buffer.byteLength(input.rawInitData, "utf8") > 8192
  )
    return "invalid-input";
  const proof = verifier.verify(input.rawInitData);
  const hash = new URLSearchParams(input.rawInitData).get("hash");
  if (!proof || !hash || !/^[0-9a-f]{64}$/i.test(hash))
    return "invalid-proof";
  const digest = createHash("sha256")
    .update("telegram-initdata-exchange-v1\0")
    .update(hash.toLowerCase())
    .digest();

  return transaction(async (client) => {
    const fingerprint = await lockTelegramUser(
      client,
      fingerprintSecret,
      proof.telegramUserId,
    );
    const prepared = await client.query<{
      tenant_id: string;
      identity_id: string;
      legacy_link_id: string;
    }>(
      `SELECT tenant_id::text,identity_id::text,legacy_link_id::text
       FROM cookie_identity.legacy_telegram_migration_preparations
       WHERE request_id=$1::uuid AND proof_sha256<>$2::bytea
       FOR UPDATE NOWAIT`,
      [input.requestId, digest],
    );
    const source = prepared.rows[0];
    if (!source) return "target-mismatch";

    // Lock every scope row used by preflight; NOWAIT aborts rather than
    // waiting in a conflicting order with existing operator/booking paths.
    // Identity + membership UPDATE locks also fence new FK-backed inserts.
    const member = [source.tenant_id, source.identity_id];
    const identity = await client.query(
      "SELECT id FROM cookie_identity.identities WHERE id=$1::uuid FOR UPDATE NOWAIT",
      [source.identity_id],
    );
    if (identity.rowCount !== 1) return "target-mismatch";
    await client.query(
      "SELECT id FROM cookie_tenancy.organizations WHERE id=$1::uuid FOR SHARE NOWAIT",
      [source.tenant_id],
    );
    await client.query(
      "SELECT identity_id FROM cookie_identity.memberships WHERE identity_id=$1::uuid ORDER BY tenant_id FOR UPDATE NOWAIT",
      [source.identity_id],
    );
    const link = await client.query(
      `SELECT id FROM cookie_identity.telegram_identity_links
       WHERE tenant_id=$1::uuid AND identity_id=$2::uuid
         AND id=$3::uuid AND telegram_user_hmac_sha256=$4::bytea
         AND revoked_at IS NULL FOR UPDATE NOWAIT`,
      [...member, source.legacy_link_id, fingerprint],
    );
    if (link.rowCount !== 1) return "target-mismatch";
    await client.query(
      `SELECT id FROM cookie_identity.role_assignments
       WHERE tenant_id=$1::uuid AND identity_id=$2::uuid
       ORDER BY id FOR SHARE NOWAIT`,
      member,
    );
    await client.query(
      `SELECT id FROM cookie_identity.roles WHERE tenant_id=$1::uuid
       AND id IN (SELECT role_id FROM cookie_identity.role_assignments
         WHERE tenant_id=$1::uuid AND identity_id=$2::uuid)
       ORDER BY id FOR SHARE NOWAIT`,
      member,
    );
    const current = verifier.verify(input.rawInitData);
    if (
      !current ||
      current.channel !== proof.channel ||
      current.telegramUserId !== proof.telegramUserId ||
      current.authDateUnixSeconds !== proof.authDateUnixSeconds
    )
      return "invalid-proof";

    const previous = await client.query(
      `SELECT 1 FROM cookie_identity.global_telegram_identities
       WHERE migration_request_id=$1::uuid AND identity_id=$2::uuid
         AND legacy_tenant_id=$3::uuid AND legacy_link_id=$4::uuid
         AND telegram_user_hmac_sha256=$5::bytea AND legacy_revoked_at IS NULL`,
      [
        input.requestId,
        source.identity_id,
        source.tenant_id,
        source.legacy_link_id,
        fingerprint,
      ],
    );
    if (previous.rowCount === 1) return "already-activated";

    const assessment = await assessLegacyTelegramMigration(
      async (work) => work(client),
      verifier,
      fingerprintSecret,
      input.rawInitData,
    );
    if (assessment !== "candidate-for-review") return "not-eligible";

    // A conflict after checks throws and rolls back all writes. The global
    // proof store is shared with Mini App/OIDC login. No old identity is merged.
    await client.query(
      `INSERT INTO cookie_identity.global_telegram_exchanges(proof_sha256,identity_id)
       VALUES($1::bytea,$2::uuid)`,
      [digest, source.identity_id],
    );
    await client.query(
      `INSERT INTO cookie_identity.global_telegram_identities
       (telegram_user_hmac_sha256,identity_id,legacy_tenant_id,legacy_link_id,migration_request_id)
       VALUES($1::bytea,$2::uuid,$3::uuid,$4::uuid,$5::uuid)`,
      [
        fingerprint,
        source.identity_id,
        source.tenant_id,
        source.legacy_link_id,
        input.requestId,
      ],
    );
    await client.query(
      `UPDATE cookie_identity.opaque_sessions SET revoked_at=clock_timestamp()
       WHERE tenant_id=$1::uuid AND identity_id=$2::uuid AND revoked_at IS NULL`,
      member,
    );
    await appendAuthIdentityAudit(
      client,
      "telegram_provider_linked",
      source.identity_id,
    );
    return "activated";
  });
}
