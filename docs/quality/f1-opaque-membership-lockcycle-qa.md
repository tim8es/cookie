# F1 QA — Cookie Session ↔ Membership revocation lock cycle (#165, #113)

**Status:** independent **negative / red regression** on exact baseline of backend PR #173 (ddfc2e141b805486b4d3ed8990a3e66dff2a9c8d). This branch is **test-only**. It does not change or fix production code and is not eligible for merge until the regression becomes green on a canonical backend patch.

## Why this differs from QA #162 and #172

PR #162 proves revocation-first Cookie bearer / Telegram unlink may authorize stale Booking. PR #172 adds expiry-before-mutation. PR #173 takes a Telegram-link and session lock before Booking writes, but the current source orders those locks **before** the tenant policy row locks. This interacts with migration 0022_opaque_identity_sessions.sql: Membership disable takes a Membership UPDATE lock; an AFTER UPDATE trigger then updates its sessions. A guarded Booking currently holds Session SHARE and only later requests Membership SHARE.

The resulting cycle:
- Transaction A: Session FOR SHARE, then waits for Membership FOR SHARE.
- Transaction B: Membership UPDATE, then trigger waits for Session UPDATE.

The integration test uses pg_blocking_pids to synchronize on the blocked UPDATE; the query gateway pauses **after the actual Session SHARE has been acquired**. There is no guessed interleaving. PostgreSQL may report deadlock SQLSTATE 40P01 in the unsafe implementation.

## Acceptance

- Protected requireTenantPermission and the Membership-disable trigger serialize without SQLSTATE 40P01 or timeout.
- Revoke-first denies stale bearer; command-first may finish, with revoke waiting until commit.
- Preserve Organization → Membership → RoleAssignments → Roles lock order from #113, then link→session ordering (or demonstrate a comparably safe reviewed protocol).
- Do not relax QA #162 bearer/link revocation, QA #172 expiry, FK integrity, idempotency or tenant isolation.
- Real PostgreSQL 16 and exact combined-head CI. A RED test-only PR is not release readiness.

## Boundaries

Synthetic UUID identities, fabricated consent fingerprint and test-only Cookie bearer. No external Telegram, PII, payments or production routes. All queries delegate to a real PostgreSQL PoolClient; instrumentation only pauses the test. On failure test connections are rolled back and synthetic fixtures cleaned. No backend, workflow or existing QA source changed.
