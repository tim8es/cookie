# F1 Identity / Tenant / Policy — contracts, not an auth provider

This package is an incremental part of [Issue #18](https://github.com/tim8es/cookie/issues/18), based on ADR-0004. It adds a pure, **deny-by-default** evaluator for trusted server-side policy input and a narrow audit port. It does not create sessions, verify credentials, persist membership, or expose APIs.

## Trusted boundary and scope
- `TrustedActor` (identity, tenant, correlation ID) **must** be supplied only by a verified server-side auth adapter. Never parse it directly from browser, Telegram, AI tool arguments or other user-provided JSON.
- `ProtectedResource` and its booking/customer relations **must** be loaded by a tenant-filtered repository. Never accept customer-to-staff relationships from the client request.
- Membership can contain multiple active role assignments with organization-wide or individual-location scope. Assigned roles are separate from editable `displayName` and StaffProfile `positionTitle`.
- A role's explicit permission codes are checked only within its tenant/location. Organization-wide access requires an organization-wide assignment; combining locations does not imply it.
- Staff permission checks on Booking and Customer additionally require server-resolved staff/booking linkage. Phone/history/notes each need distinct permission codes; absence denies.
- Client role access is limited to server-linked owned Booking. **Guest token verification is NOT implemented**.
- Protected owner actions require the actual owner identity, an active owner-type role and organization-wide scope. `organization.transfer-owner` is non-delegable even if an internal caller forgets to mark `ownerProtected`; other protected operations must be explicitly registered in policy as work proceeds.

## Audit and failure behavior
`authorizeSensitive` writes a preflight authorization decision before allowing command handling; audit persistence failure aborts preflight. This is **not** proof of a committed mutation or a transactional audit log. Actual mutation/outbox/audit-in-one-transaction belongs to #19 and the consuming domain commands.

## Deliberate F1 gaps (Issue #18 remains OPEN)
- Real phone OTP / Telegram verification, trusted-session issuance and revocation.
- Persistence of Identity, Membership, RoleAssignments, Organization and resource relations.
- Explicit owner-transfer protocol, full permission catalog and admin customization guardrails.
- AuthZ wiring into all API, commands, queries, workers, Telegram and exports.
- DB-backed cross-tenant tests, field-level response serializers, real audit persistence and denial-enumeration hardening.
- Legal review before any real personal data or commercial pilot.

## Validation
`pnpm test` includes negative scope, customer-field, owner, cross-tenant and audit tests. `pnpm build` includes the policy source, and CI checks formatting, TypeScript and current module boundaries.


## PostgreSQL-backed F1 slice (Issue #18 / #19, 2026-11-15)
- `db/migrations/0002_identity_tenancy.sql` introduces versioned schemas `cookie_identity` and `cookie_tenancy` with synthetic-only identity IDs, Organizations, Locations, Memberships, Roles, location-scoped RoleAssignments and compact authorization preflight audit. **No email, phone, login credential, payment data or message content is stored.**
- Composite tenant foreign keys on Membership, RoleAssignment, Role and Location protect against cross-tenant references. One branch-scoped assignment represents a single branch; assigning a role to multiple locations requires multiple assignments. No cross-tenant role import is allowed.
- `loadPolicySnapshot(client, trustedActor)` reads the membership and role assignment set with **one SQL statement**, so it cannot combine roles from different versions of those tables within that statement. The caller must authenticate `trustedActor` independently, open the database client and define the transaction boundary.
- `requireTenantPermission` links the existing default-deny evaluator with a PostgreSQL audit port. It emits only actor/tenant/correlation UUID, permission and decision; not contacts, tokens or booking payload. Audit failure blocks sensitive preflight. A preflight log is **not** a committed mutation audit.
- The schema intentionally does not yet model real StaffProfile/booking/customer links. Staff resource access remains denied by this DB-backed path until database-verified links are implemented.
- Negative integration tests use a temporary PostgreSQL transaction and **only synthetic UUIDs**. They test branch-specific roles, cross-tenant composite foreign keys, a delegated Owner attempt, persisted allow/deny decisions and membership revocation.

**Remaining work / security boundary:** no HTTP authentication, no OTP or Telegram verification, no access-token issuance, no API business endpoint or real customer data is introduced. No production RLS/DB least privilege policy or secure mutating command transaction is claimed. A one-statement policy read may become stale before a later mutation; the actual command must enforce its own transaction-scoped authorization and revocation/concurrency contract. The real audit/retention/legal/backup gate and outbox remain open in #18/#19.
