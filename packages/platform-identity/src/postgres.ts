import type { PoolClient, QueryResultRow } from "pg";

import {
  requireSensitiveAuthorization,
  AuthorizationDeniedError,
  type AuthorizationRequest,
  type Membership,
  type OrganizationRole,
  type PolicyAuditEvent,
  type PolicyAuditPort,
  type PolicySnapshot,
  type ProtectedResource,
  type RoleAssignment,
  type RoleType,
  type TrustedActor,
} from "./authorization.js";

interface PolicyRow extends QueryResultRow {
  owner_identity_id: string;
  membership_identity_id: string | null;
  membership_active: boolean | null;
  assignment_id: string | null;
  assignment_active: boolean | null;
  assignment_location_id: string | null;
  role_id: string | null;
  role_base_type: RoleType | null;
  role_display_name: string | null;
  role_permissions: string[] | null;
  role_active: boolean | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Reads an internally authenticated identity's organization-scoped policy.
 * A single SQL statement provides a consistent MVCC snapshot. Never accept
 * raw client-supplied actor or resource relationships.
 *
 * Sensitive mutation callers must manage a transaction and recheck policy
 * at the mutation boundary; this read alone cannot prevent revocation races.
 */
export async function loadPolicySnapshot(
  client: PoolClient,
  actor: TrustedActor,
): Promise<PolicySnapshot> {
  if (!UUID_RE.test(actor.identityId) || !UUID_RE.test(actor.tenantId)) {
    throw new Error("Trusted actor has invalid identity/tenant IDs");
  }

  const result = await client.query<PolicyRow>(
    `
      SELECT
        org.owner_identity_id::text AS owner_identity_id,
        mem.identity_id::text AS membership_identity_id,
        mem.active AS membership_active,
        ra.id::text AS assignment_id,
        ra.active AS assignment_active,
        ra.location_id::text AS assignment_location_id,
        role.id::text AS role_id,
        role.base_type AS role_base_type,
        role.display_name AS role_display_name,
        role.permissions AS role_permissions,
        role.active AS role_active
      FROM cookie_tenancy.organizations AS org
      LEFT JOIN cookie_identity.memberships AS mem
        ON mem.tenant_id = org.id AND mem.identity_id = $2::uuid
      LEFT JOIN cookie_identity.role_assignments AS ra
        ON ra.tenant_id = mem.tenant_id AND ra.identity_id = mem.identity_id
      LEFT JOIN cookie_identity.roles AS role
        ON role.tenant_id = ra.tenant_id AND role.id = ra.role_id
      WHERE org.id = $1::uuid
      ORDER BY ra.id
    `,
    [actor.tenantId, actor.identityId],
  );

  const first = result.rows[0];
  if (!first) {
    return { ownerIdentityId: "", membership: null, roles: [] };
  }

  const assignments: RoleAssignment[] = [];
  const roles = new Map<string, OrganizationRole>();
  for (const row of result.rows) {
    if (
      row.role_id &&
      row.role_base_type &&
      row.role_display_name !== null &&
      row.role_permissions !== null &&
      row.role_active !== null
    ) {
      roles.set(row.role_id, {
        id: row.role_id,
        tenantId: actor.tenantId,
        baseType: row.role_base_type,
        displayName: row.role_display_name,
        permissions: row.role_permissions,
        active: row.role_active,
      });
    }
    if (row.assignment_id && row.role_id && row.assignment_active !== null) {
      assignments.push({
        roleId: row.role_id,
        active: row.assignment_active,
        scope: row.assignment_location_id
          ? { kind: "locations", locationIds: [row.assignment_location_id] }
          : { kind: "organization" },
        // No staff identity mapping until StaffProfile data has a real FK.
        // Staff/customer relation access is intentionally denied by policy.
      });
    }
  }
  const membership: Membership | null = first.membership_identity_id
    ? {
        identityId: first.membership_identity_id,
        tenantId: actor.tenantId,
        active: first.membership_active === true,
        assignments,
      }
    : null;

  return {
    ownerIdentityId: first.owner_identity_id,
    membership,
    roles: [...roles.values()],
  };
}

/**
 * Synchronize authorization with concurrent policy changes. These row locks
 * remain held until COMMIT/ROLLBACK when the caller uses one transaction-scoped
 * PoolClient. In particular, a revocation UPDATE cannot commit while a
 * previously authorized Booking command is still executing.
 *
 * The order is fixed (Organization -> Membership -> Assignments -> Roles)
 * to prevent lock inversion between guarded commands. FOR SHARE permits
 * parallel authorized commands; it conflicts with UPDATE/DELETE of any
 * policy row that contributed to the permission snapshot. Missing rows
 * remain default-denied; an in-flight grant cannot authorize an old request.
 *
 * Never replace this with a late unlocked SELECT: revocation could still
 * commit between that check and the business transaction's COMMIT.
 */
async function lockPolicyRows(
  client: PoolClient,
  actor: TrustedActor,
): Promise<void> {
  if (!UUID_RE.test(actor.identityId) || !UUID_RE.test(actor.tenantId)) {
    throw new Error("Trusted actor has invalid identity/tenant IDs");
  }

  const params = [actor.tenantId, actor.identityId];
  await client.query(
    `SELECT id FROM cookie_tenancy.organizations
       WHERE id=$1::uuid FOR SHARE`,
    [actor.tenantId],
  );
  await client.query(
    `SELECT identity_id FROM cookie_identity.memberships
       WHERE tenant_id=$1::uuid AND identity_id=$2::uuid FOR SHARE`,
    params,
  );
  await client.query(
    `SELECT id FROM cookie_identity.role_assignments
       WHERE tenant_id=$1::uuid AND identity_id=$2::uuid
       ORDER BY id FOR SHARE`,
    params,
  );
  await client.query(
    `SELECT id FROM cookie_identity.roles
       WHERE tenant_id=$1::uuid
         AND id IN (
           SELECT role_id FROM cookie_identity.role_assignments
             WHERE tenant_id=$1::uuid AND identity_id=$2::uuid
         )
       ORDER BY id FOR SHARE`,
    params,
  );
}

interface OpaqueSessionLinkRow extends QueryResultRow {
  telegram_link_id: string | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Transaction-scoped Cookie AuthN guard. Caller MUST hold a real PostgreSQL
 * transaction until the protected Booking command or read completes.
 *
 * A preliminary unlocked lookup discovers the optional Telegram link. It
 * conveys NO authority. Lock the link first (unlink updates link -> session
 * through its trigger), then lock and revalidate the EXACT bearer session.
 * Both SHARE locks survive until transaction COMMIT/ROLLBACK, so neither a
 * direct bearer revoke nor Telegram unlink can commit before the command.
 *
 * Internal actors and explicitly synthetic non-Cookie verifier ports have
 * no Cookie credential; their separate trusted AuthN contract is unchanged.
 */
export async function assertActiveOpaqueSession(
  client: PoolClient,
  actor: TrustedActor,
): Promise<void> {
  const digest = actor.opaqueSessionTokenSha256;
  if (digest === undefined) return;
  if (
    !SHA256_HEX.test(digest) ||
    !UUID_RE.test(actor.tenantId) ||
    !UUID_RE.test(actor.identityId)
  ) {
    throw new AuthorizationDeniedError();
  }
  const params = [digest, actor.tenantId, actor.identityId];
  const identified = await client.query<OpaqueSessionLinkRow>(
    `SELECT telegram_link_id::text AS telegram_link_id
       FROM cookie_identity.opaque_sessions
      WHERE token_sha256=decode($1::text,'hex')
        AND tenant_id=$2::uuid AND identity_id=$3::uuid`,
    params,
  );
  const candidate = identified.rows[0];
  if (!candidate) throw new AuthorizationDeniedError();

  if (candidate.telegram_link_id !== null) {
    const linked = await client.query(
      `SELECT id FROM cookie_identity.telegram_identity_links
        WHERE tenant_id=$1::uuid AND identity_id=$2::uuid
          AND id=$3::uuid AND revoked_at IS NULL
          AND proof_verified_at IS NOT NULL
          AND consent_confirmed_at IS NOT NULL
        FOR SHARE`,
      [actor.tenantId, actor.identityId, candidate.telegram_link_id],
    );
    if (linked.rowCount !== 1) throw new AuthorizationDeniedError();
  }

  // This second statement is the authoritative, locked check. Under READ
  // COMMITTED it re-evaluates all predicates after any concurrent revoke.
  // Matching link ID protects against a changed/rebound session after lookup.
  const current = await client.query(
    `SELECT token_sha256 FROM cookie_identity.opaque_sessions
      WHERE token_sha256=decode($1::text,'hex')
        AND tenant_id=$2::uuid AND identity_id=$3::uuid
        AND revoked_at IS NULL AND expires_at > clock_timestamp()
        AND telegram_link_id IS NOT DISTINCT FROM $4::uuid
      FOR SHARE`,
    [...params, candidate.telegram_link_id],
  );
  if (current.rowCount !== 1) throw new AuthorizationDeniedError();
}

/** Only safe preflight metadata is stored, never tokens, contacts or payload. */
export class PostgresPolicyAudit implements PolicyAuditPort {
  constructor(private readonly client: PoolClient) {}

  async append(event: PolicyAuditEvent): Promise<void> {
    await this.client.query(
      `
        INSERT INTO cookie_identity.authorization_audit
          (tenant_id, actor_identity_id, correlation_id, location_id,
           permission, allowed, reason)
        VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7)
      `,
      [
        event.tenantId,
        event.actorIdentityId,
        event.correlationId,
        event.locationId ?? null,
        event.permission,
        event.allowed,
        event.reason,
      ],
    );
  }
}

/**
 * Server-internal guard only. It does NOT authenticate credentials.
 * Acquire the supplied client from a controlled transaction for mutations.
 */
export async function requireTenantPermission(
  client: PoolClient,
  actor: TrustedActor,
  resource: ProtectedResource,
  permission: string,
): Promise<void> {
  const request: AuthorizationRequest = { actor, resource, permission };
  await assertActiveOpaqueSession(client, actor);
  await lockPolicyRows(client, actor);
  const snapshot = await loadPolicySnapshot(client, actor);
  await requireSensitiveAuthorization(
    request,
    snapshot,
    new PostgresPolicyAudit(client),
  );
}
