import { createHash } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";

import type { TrustedActor } from "./authorization.js";

/**
 * Internal F1 PostgreSQL guard. Only a trusted API adapter may supply this
 * already-verified bearer and actor. No production route uses it by default.
 */
export interface VerifiedOpaqueBearerCommandAuthority {
  /** Obtained from the authenticated Authorization header, never JSON. */
  readonly bearerToken: string;
  readonly actor: Pick<TrustedActor, "tenantId" | "identityId">;
  /** Trusted server-side provider configuration, not request parameters. */
  readonly issuer: string;
  readonly audience: string;
}

export class OpaqueSessionAuthorityDeniedError extends Error {
  constructor() {
    super("SESSION_AUTHORITY_DENIED");
    this.name = "OpaqueSessionAuthorityDeniedError";
  }
}

interface LinkLocatorRow extends QueryResultRow {
  telegram_link_id: string | null;
}

const BEARER = /^cs_[A-Za-z0-9_-]{43}$/;
const LABEL = /^[a-zA-Z0-9._:/-]{1,128}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function deny(): never {
  throw new OpaqueSessionAuthorityDeniedError();
}

/**
 * Call inside the SAME already-open PostgreSQL transaction as the protected
 * command, BEFORE policy checks, idempotent replay and business mutations.
 *
 * Order: membership SHARE -> Telegram link SHARE -> session SHARE.
 * This matches member-disable and link-unlink trigger ordering and holds
 * all three row locks through the caller's COMMIT or ROLLBACK.
 *
 * The first unprotected session read is ONLY a link locator: it grants no
 * authority. Every mutable assertion is repeated under an authoritative
 * PostgreSQL row lock. A revocation COMMIT first must reject; a guarded
 * command first must make that exact revocation wait.
 *
 * Do not call via Pool.query/autocommit: row locks would end immediately.
 * Database failures propagate for the caller to roll back and fail closed.
 */
export async function requireOpaqueSessionCommandAuthority(
  client: PoolClient,
  authority: VerifiedOpaqueBearerCommandAuthority,
): Promise<void> {
  if (
    !authority ||
    !BEARER.test(authority.bearerToken) ||
    !UUID.test(authority.actor?.tenantId ?? "") ||
    !UUID.test(authority.actor?.identityId ?? "") ||
    !LABEL.test(authority.issuer) ||
    !LABEL.test(authority.audience)
  ) {
    deny();
  }

  // Never send or log the bearer token itself to PostgreSQL.
  const tokenHash = createHash("sha256")
    .update(authority.bearerToken, "utf8")
    .digest();
  const params = [
    tokenHash,
    authority.issuer,
    authority.audience,
    authority.actor.tenantId,
    authority.actor.identityId,
  ];

  // Locating the link is NOT permission. Its value is rechecked after
  // taking tenant/member and link locks and then locking the exact session.
  const located = await client.query<LinkLocatorRow>(
    [
      "SELECT telegram_link_id::text AS telegram_link_id",
      "FROM cookie_identity.opaque_sessions",
      "WHERE token_sha256=$1::bytea AND issuer=$2 AND audience=$3",
      "AND tenant_id=$4::uuid AND identity_id=$5::uuid",
    ].join("\n"),
    params,
  );
  const original = located.rows[0];
  if (!original) deny();

  const membership = await client.query(
    [
      "SELECT 1 FROM cookie_identity.memberships",
      "WHERE tenant_id=$1::uuid AND identity_id=$2::uuid",
      "AND active FOR SHARE",
    ].join("\n"),
    [authority.actor.tenantId, authority.actor.identityId],
  );
  if (membership.rowCount !== 1) deny();

  if (original.telegram_link_id !== null) {
    const link = await client.query(
      [
        "SELECT 1 FROM cookie_identity.telegram_identity_links",
        "WHERE tenant_id=$1::uuid AND identity_id=$2::uuid",
        "AND id=$3::uuid AND revoked_at IS NULL FOR SHARE",
      ].join("\n"),
      [
        authority.actor.tenantId,
        authority.actor.identityId,
        original.telegram_link_id,
      ],
    );
    if (link.rowCount !== 1) deny();
  }

  const session = await client.query<LinkLocatorRow>(
    [
      "SELECT telegram_link_id::text AS telegram_link_id",
      "FROM cookie_identity.opaque_sessions",
      "WHERE token_sha256=$1::bytea AND issuer=$2 AND audience=$3",
      "AND tenant_id=$4::uuid AND identity_id=$5::uuid",
      "AND revoked_at IS NULL AND expires_at > clock_timestamp()",
      "FOR SHARE",
    ].join("\n"),
    params,
  );
  // An administrative link rebind must never swap authority mid-transaction.
  if (
    session.rowCount !== 1 ||
    session.rows[0]?.telegram_link_id !== original.telegram_link_id
  ) {
    deny();
  }
}
