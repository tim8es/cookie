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
