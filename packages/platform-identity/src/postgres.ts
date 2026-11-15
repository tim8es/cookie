import type { PoolClient, QueryResultRow } from "pg";

import {
  requireSensitiveAuthorization,
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
  const snapshot = await loadPolicySnapshot(client, actor);
  await requireSensitiveAuthorization(
    request,
    snapshot,
    new PostgresPolicyAudit(client),
  );
}
