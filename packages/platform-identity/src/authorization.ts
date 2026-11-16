/**
 * F1 policy contracts only. Caller must supply trusted session claims and
 * database-resolved resource relations; no user JSON is a trusted actor.
 * This package does not implement login, token verification or persistence.
 */

export type RoleType = "client" | "staff" | "admin" | "owner";
export type RoleScope =
  | { readonly kind: "organization" }
  | { readonly kind: "locations"; readonly locationIds: readonly string[] };

export interface OrganizationRole {
  readonly id: string;
  readonly tenantId: string;
  readonly baseType: RoleType;
  /** Display names have no authorization meaning. */
  readonly displayName: string;
  readonly permissions: readonly string[];
  readonly active: boolean;
}

export interface RoleAssignment {
  readonly roleId: string;
  readonly scope: RoleScope;
  readonly active: boolean;
  /** Server-verified StaffProfile for staff-related access only. */
  readonly staffProfileId?: string;
}

export interface Membership {
  readonly identityId: string;
  readonly tenantId: string;
  readonly active: boolean;
  readonly assignments: readonly RoleAssignment[];
}

/** Only the trusted PostgreSQL bearer verifier can supply this provenance. */
export interface OpaqueSessionAuthority {
  readonly tokenSha256: string;
  readonly issuer: string;
  readonly audience: string;
}

/** Construct ONLY after server-side session/identity verification. */
export interface TrustedActor {
  readonly identityId: string;
  readonly tenantId: string;
  readonly correlationId: string;
  /** Do not serialize, log or accept this as a client-supplied actor claim. */
  readonly opaqueSessionAuthority?: OpaqueSessionAuthority;
}

/** Relations must be loaded from authoritative tenant-scoped storage. */
export type ProtectedResource =
  | {
      readonly kind: "organization";
      readonly tenantId: string;
      readonly locationId?: string;
    }
  | {
      readonly kind: "booking";
      readonly tenantId: string;
      readonly locationId: string;
      readonly staffProfileId: string;
      readonly clientIdentityId?: string;
    }
  | {
      readonly kind: "schedule";
      readonly tenantId: string;
      readonly locationId: string;
      readonly staffProfileId: string;
    }
  | {
      readonly kind: "customer";
      readonly tenantId: string;
      readonly locationId: string;
      /** Staff with current booking-linked access (server-computed). */
      readonly linkedStaffProfileIds: readonly string[];
    };

export interface AuthorizationRequest {
  readonly actor: TrustedActor;
  readonly resource: ProtectedResource;
  readonly permission: string;
  /** Owner-only operations never become delegable via custom roles. */
  readonly ownerProtected?: boolean;
}

/** Non-delegable actions remain protected even if a caller omits ownerProtected. */
const SYSTEM_OWNER_ONLY_PERMISSIONS = new Set(["organization.transfer-owner"]);

export interface PolicySnapshot {
  readonly ownerIdentityId: string;
  readonly membership: Membership | null;
  readonly roles: readonly OrganizationRole[];
}

export type DenialReason =
  | "invalid-context"
  | "foreign-tenant"
  | "inactive-membership"
  | "invalid-role-config"
  | "owner-required"
  | "permission-denied";

export type AuthorizationDecision =
  | { readonly allowed: true; readonly reason: "granted" }
  | { readonly allowed: false; readonly reason: DenialReason };

function deny(reason: DenialReason): AuthorizationDecision {
  return { allowed: false, reason };
}

function covers(scope: RoleScope, locationId: string | undefined): boolean {
  if (locationId === undefined) return scope.kind === "organization";
  return (
    scope.kind === "organization" ||
    (scope.kind === "locations" && scope.locationIds.includes(locationId))
  );
}

function relationAllows(
  role: OrganizationRole,
  assignment: RoleAssignment,
  resource: ProtectedResource,
  actorIdentityId: string,
): boolean {
  if (role.baseType === "client") {
    return (
      resource.kind === "booking" &&
      !!resource.clientIdentityId &&
      resource.clientIdentityId === actorIdentityId
    );
  }
  if (role.baseType === "staff") {
    // A staff role cannot elevate a list-level organization query into CRM access.
    if (resource.kind === "organization") return false;
    if (!assignment.staffProfileId) return false;
    if (resource.kind === "booking" || resource.kind === "schedule") {
      return resource.staffProfileId === assignment.staffProfileId;
    }
    if (resource.kind === "customer") {
      return resource.linkedStaffProfileIds.includes(assignment.staffProfileId);
    }
  }
  return true;
}

/**
 * Pure default-deny evaluator, not a session verifier or DB lookup.
 * Permission union applies only to active roles within the requested tenant
 * and current location; a staff role cannot escape own-record constraints.
 */
export function evaluateAuthorization(
  request: AuthorizationRequest,
  snapshot: PolicySnapshot,
): AuthorizationDecision {
  const { actor, resource, permission } = request;
  if (
    !actor.identityId ||
    !actor.tenantId ||
    !actor.correlationId ||
    !resource.tenantId ||
    !permission
  ) {
    return deny("invalid-context");
  }
  if (actor.tenantId !== resource.tenantId) return deny("foreign-tenant");

  const { membership, ownerIdentityId } = snapshot;
  if (
    !membership?.active ||
    membership.identityId !== actor.identityId ||
    membership.tenantId !== actor.tenantId
  ) {
    return deny("inactive-membership");
  }

  const roles = new Map<string, OrganizationRole>();
  for (const role of snapshot.roles) {
    if (roles.has(role.id)) return deny("invalid-role-config");
    roles.set(role.id, role);
  }

  const ownerProtected =
    request.ownerProtected || SYSTEM_OWNER_ONLY_PERMISSIONS.has(permission);
  if (ownerProtected && actor.identityId !== ownerIdentityId) {
    return deny("owner-required");
  }

  for (const assignment of membership.assignments) {
    if (!assignment.active || !covers(assignment.scope, resource.locationId)) {
      continue;
    }
    const role = roles.get(assignment.roleId);
    if (!role?.active || role.tenantId !== actor.tenantId) continue;
    if (!role.permissions.includes(permission)) continue;

    // Owner status is never inferred from role title, custom permissions
    // or a role assigned to a different identity.
    if (role.baseType === "owner") {
      if (actor.identityId !== ownerIdentityId) continue;
    }
    if (
      ownerProtected &&
      (role.baseType !== "owner" || assignment.scope.kind !== "organization")
    ) {
      continue;
    }

    if (!relationAllows(role, assignment, resource, actor.identityId)) {
      continue;
    }
    return { allowed: true, reason: "granted" };
  }
  return deny(ownerProtected ? "owner-required" : "permission-denied");
}

/** Minimal audit port: persistence/transaction semantics belong to #19. */
export interface PolicyAuditEvent {
  readonly category: "authorization";
  readonly actorIdentityId: string;
  readonly tenantId: string;
  readonly correlationId: string;
  readonly locationId?: string;
  readonly permission: string;
  readonly allowed: boolean;
  readonly reason: AuthorizationDecision["reason"];
}

export interface PolicyAuditPort {
  append(event: PolicyAuditEvent): Promise<void>;
}

/**
 * Required preflight for sensitive commands: audit failure rejects access
 * before command execution. A successful preflight is NOT a mutation audit.
 */
export async function authorizeSensitive(
  request: AuthorizationRequest,
  snapshot: PolicySnapshot,
  audit: PolicyAuditPort,
): Promise<AuthorizationDecision> {
  const decision = evaluateAuthorization(request, snapshot);
  await audit.append({
    category: "authorization",
    actorIdentityId: request.actor.identityId,
    tenantId: request.actor.tenantId,
    correlationId: request.actor.correlationId,
    locationId: request.resource.locationId,
    permission: request.permission,
    allowed: decision.allowed,
    reason: decision.reason,
  });
  return decision;
}

/** Enforcement helper for command handlers: cannot mistake a denial for success. */
export class AuthorizationDeniedError extends Error {
  readonly code = "ACCESS_DENIED" as const;

  constructor() {
    super("Access denied");
    this.name = "AuthorizationDeniedError";
  }
}

export async function requireSensitiveAuthorization(
  request: AuthorizationRequest,
  snapshot: PolicySnapshot,
  audit: PolicyAuditPort,
): Promise<void> {
  const decision = await authorizeSensitive(request, snapshot, audit);
  if (!decision.allowed) throw new AuthorizationDeniedError();
}
