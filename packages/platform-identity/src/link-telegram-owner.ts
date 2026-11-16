import { randomUUID } from "node:crypto";

import type { Pool, QueryResultRow } from "pg";

import type { TelegramMiniAppProofVerifier } from "./telegram-init-data.js";
import { telegramUserFingerprint } from "./telegram-links.js";

/** Privileged operator-side binding only: never expose this function to HTTP. */
export interface TrustedOwnerTelegramLinkInput {
  readonly tenantId: string;
  readonly ownerIdentityId: string;
  readonly rawInitData: string;
  /** Operator must have recorded the verified account holder's consent. */
  readonly consentConfirmed: true;
}

export class TrustedOwnerTelegramLinkError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "INVALID_PROOF"
      | "OWNER_NOT_ACTIVE"
      | "LINK_CONFLICT",
  ) {
    super(code);
    this.name = "TrustedOwnerTelegramLinkError";
  }
}

interface LinkRow extends QueryResultRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly identity_id: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function linkVerifiedTelegramOwner(
  pool: Pool,
  verifier: TelegramMiniAppProofVerifier,
  userHashSecret: Buffer,
  input: TrustedOwnerTelegramLinkInput,
): Promise<{ readonly linkId: string; readonly replayed: boolean }> {
  if (
    !input ||
    !UUID.test(input.tenantId) ||
    !UUID.test(input.ownerIdentityId) ||
    input.consentConfirmed !== true ||
    typeof input.rawInitData !== "string" ||
    Buffer.byteLength(input.rawInitData, "utf8") > 8192 ||
    typeof verifier?.verify !== "function"
  ) {
    throw new TrustedOwnerTelegramLinkError("INVALID_INPUT");
  }
  const proof = verifier.verify(input.rawInitData);
  if (!proof || proof.channel !== "telegram-mini-app") {
    throw new TrustedOwnerTelegramLinkError("INVALID_PROOF");
  }
  const hash = telegramUserFingerprint(userHashSecret, proof.telegramUserId);
  const client = await pool.connect();
  let active = false;
  try {
    await client.query("BEGIN");
    active = true;
    // One operator action per Organization at a time, and ensure membership
    // and owner-role revocation cannot commit during the link transaction.
    const owner = await client.query(
      `SELECT org.id
         FROM cookie_tenancy.organizations org
         JOIN cookie_identity.memberships mem
           ON mem.tenant_id=org.id AND mem.identity_id=org.owner_identity_id
         JOIN cookie_identity.role_assignments assignment
           ON assignment.tenant_id=org.id
          AND assignment.identity_id=mem.identity_id
         JOIN cookie_identity.roles role
           ON role.tenant_id=org.id AND role.id=assignment.role_id
        WHERE org.id=$1::uuid AND org.owner_identity_id=$2::uuid
          AND mem.active AND assignment.active AND role.active
          AND role.base_type='owner' AND assignment.location_id IS NULL
        FOR UPDATE OF org FOR SHARE OF mem, assignment, role`,
      [input.tenantId, input.ownerIdentityId],
    );
    if (owner.rowCount !== 1) {
      throw new TrustedOwnerTelegramLinkError("OWNER_NOT_ACTIVE");
    }

    // Serialize exactly the same Telegram user across all Organizations,
    // preventing simultaneous ambiguous links on different tenants.
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      hash.readBigInt64BE(0).toString(),
    ]);
    const existing = await client.query<LinkRow>(
      `SELECT id::text,tenant_id::text,identity_id::text
         FROM cookie_identity.telegram_identity_links
        WHERE telegram_user_hmac_sha256=$1::bytea AND revoked_at IS NULL
        ORDER BY tenant_id,id FOR SHARE`,
      [hash],
    );
    if (existing.rows.length > 0) {
      const item = existing.rows[0];
      if (
        existing.rows.length !== 1 ||
        item?.tenant_id !== input.tenantId ||
        item.identity_id !== input.ownerIdentityId
      ) {
        throw new TrustedOwnerTelegramLinkError("LINK_CONFLICT");
      }
      await client.query("COMMIT");
      active = false;
      return { linkId: item.id, replayed: true };
    }

    // Do not attach a second Telegram account to an already linked owner.
    const other = await client.query(
      `SELECT id FROM cookie_identity.telegram_identity_links
        WHERE tenant_id=$1::uuid AND identity_id=$2::uuid
          AND revoked_at IS NULL FOR SHARE`,
      [input.tenantId, input.ownerIdentityId],
    );
    if (other.rowCount)
      throw new TrustedOwnerTelegramLinkError("LINK_CONFLICT");

    const linkId = randomUUID();
    await client.query(
      `INSERT INTO cookie_identity.telegram_identity_links
        (tenant_id,id,identity_id,telegram_user_hmac_sha256,
         proof_verified_at,consent_confirmed_at)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::bytea,
              to_timestamp($5::bigint),clock_timestamp())`,
      [
        input.tenantId,
        linkId,
        input.ownerIdentityId,
        hash,
        proof.authDateUnixSeconds,
      ],
    );
    await client.query("COMMIT");
    active = false;
    return { linkId, replayed: false };
  } catch (error) {
    if (active) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
