import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { assessLegacyTelegramMigration } from "./legacy-telegram-migration-preflight.js";
import type { TelegramMiniAppProofVerifier } from "./telegram-init-data.js";
import { lockTelegramUser } from "./telegram-links.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PreparationInput {
  readonly requestId: string;
  readonly tenantId: string;
  readonly identityId: string;
  readonly legacyLinkId: string;
  readonly rawInitData: string;
  readonly consentConfirmed: true;
}

export type PreparationResult =
  | "invalid-input"
  | "invalid-proof"
  | "target-mismatch"
  | "not-eligible"
  | "request-conflict"
  | "prepared"
  | "replayed";

/**
 * Proposed privileged, synthetic-only preparation. The trusted caller must
 * independently authorize the operator and record consent. Never mount this
 * as HTTP or CLI; the consent flag alone is not authorization.
 *
 * The record is review evidence only. It neither consumes a login proof nor
 * creates a provider, user, entitlement, session, or migration authority.
 * A later activation must repeat all checks in its own transaction.
 */
export async function prepareLegacyTelegramMigration(
  transaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>,
  verifier: TelegramMiniAppProofVerifier,
  fingerprintSecret: Buffer,
  input: PreparationInput,
): Promise<PreparationResult> {
  if (
    !input ||
    !UUID.test(input.requestId) ||
    !UUID.test(input.tenantId) ||
    !UUID.test(input.identityId) ||
    !UUID.test(input.legacyLinkId) ||
    input.consentConfirmed !== true ||
    typeof input.rawInitData !== "string" ||
    Buffer.byteLength(input.rawInitData, "utf8") > 8192
  )
    return "invalid-input";

  const proof = verifier.verify(input.rawInitData);
  const hash = new URLSearchParams(input.rawInitData).get("hash");
  if (
    !proof ||
    proof.channel !== "telegram-mini-app" ||
    !hash ||
    !/^[0-9a-f]{64}$/i.test(hash)
  )
    return "invalid-proof";

  const proofDigest = createHash("sha256")
    .update("telegram-initdata-exchange-v1\0")
    .update(hash.toLowerCase())
    .digest();

  return transaction(async (client) => {
    const fingerprint = await lockTelegramUser(
      client,
      fingerprintSecret,
      proof.telegramUserId,
    );
    // NOWAIT avoids waiting on membership/link locks in reverse order of
    // existing provisioning/revocation paths. A conflict aborts the entire
    // transaction; the caller may explicitly retry with a fresh proof.
    const target = await client.query(
      `SELECT l.id
       FROM cookie_identity.telegram_identity_links l
       JOIN cookie_identity.memberships m
         ON m.tenant_id=l.tenant_id AND m.identity_id=l.identity_id
       WHERE l.tenant_id=$1::uuid AND l.identity_id=$2::uuid
         AND l.id=$3::uuid AND l.telegram_user_hmac_sha256=$4::bytea
         AND l.revoked_at IS NULL AND m.active
       FOR SHARE OF l,m NOWAIT`,
      [input.tenantId, input.identityId, input.legacyLinkId, fingerprint],
    );
    if (target.rowCount !== 1) return "target-mismatch";

    const assessment = await assessLegacyTelegramMigration(
      async (work) => work(client),
      verifier,
      fingerprintSecret,
      input.rawInitData,
    );
    if (assessment !== "candidate-for-review") return "not-eligible";

    const current = verifier.verify(input.rawInitData);
    if (
      !current ||
      current.channel !== proof.channel ||
      current.telegramUserId !== proof.telegramUserId ||
      current.authDateUnixSeconds !== proof.authDateUnixSeconds
    )
      return "invalid-proof";

    const args = [
      input.requestId,
      input.tenantId,
      input.identityId,
      input.legacyLinkId,
      proofDigest,
    ];
    const inserted = await client.query(
      `INSERT INTO cookie_identity.legacy_telegram_migration_preparations
       (request_id,tenant_id,identity_id,legacy_link_id,proof_sha256)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bytea)
       ON CONFLICT DO NOTHING RETURNING request_id`,
      args,
    );
    if (inserted.rowCount === 1) return "prepared";
    const prior = await client.query(
      `SELECT 1 FROM cookie_identity.legacy_telegram_migration_preparations
       WHERE request_id=$1::uuid AND tenant_id=$2::uuid AND identity_id=$3::uuid
         AND legacy_link_id=$4::uuid AND proof_sha256=$5::bytea`,
      args,
    );
    return prior.rowCount === 1 ? "replayed" : "request-conflict";
  });
}
