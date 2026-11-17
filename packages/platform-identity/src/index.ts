/**
 * Public F1 policy capability used by internal business commands.
 * Caller MUST hold its trusted PostgreSQL transaction and preserve lock order.
 * Authentication/issuer verification remains owned by Identity.
 */
export type { TrustedActor } from "./authorization.js";
export { requireTenantPermission } from "./postgres.js";
