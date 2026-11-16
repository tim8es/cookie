# F1 QA — Cookie Session ↔ Membership revocation lock cycle (#165, #113)

**Status:** independent **test-only positive regression** on corrected backend PR #173 (base SHA 48e8ba8b59b85eb8cb31d7b8d0e8cc4dbd4455f2). The initial implementation at ddfc2e141b805486b4d3ed8990a3e66dff2a9c8d had a source-level lock-order inversion; the backend owner corrected it **before this new test was executed**. Therefore this test does **not** provide a recorded RED reproduction of the original interleaving. Current exact-head QA SHA 6ddba5755b1e82dcded005b9cd1f105ce8c44901 has [full F1 CI SUCCESS](https://github.com/tim8es/cookie/actions/runs/43914072659), including this PostgreSQL test. The branch is test-only and does not itself fix production code.

## Why this differs from QA #162 and #172

PR #162 proves revocation-first Cookie bearer / Telegram unlink may authorize stale Booking. PR #172 adds expiry-before-mutation. PR #173 takes a Telegram-link and session lock before Booking writes, but the current source orders those locks **before** the tenant policy row locks. This interacts with migration 0022_opaque_identity_sessions.sql: Membership disable takes a Membership UPDATE lock; an AFTER UPDATE trigger then updates its sessions. A guarded Booking currently holds Session SHARE and only later requests Membership SHARE.

The resulting cycle:
- Transaction A: Session FOR SHARE, then waits for Membership FOR SHARE.
- Transaction B: Membership UPDATE, then trigger waits for Session UPDATE.

The integration test uses pg_blocking_pids to synchronize on the blocked UPDATE; the query gateway pauses **after the actual Session SHARE has been acquired**. There is no guessed interleaving. The test fails if an unsafe implementation produces SQLSTATE 40P01; the corrected PR #173 implementation serializes both transactions and the test passes.

## Acceptance

- Protected requireTenantPermission and the Membership-disable trigger serialize without SQLSTATE 40P01 or timeout.
- Revoke-first denies stale bearer; command-first may finish, with revoke waiting until commit.
- Preserve Organization → Membership → RoleAssignments → Roles lock order from #113, then link→session ordering (or demonstrate a comparably safe reviewed protocol).
- Do not relax QA #162 bearer/link revocation, QA #172 expiry, FK integrity, idempotency or tenant isolation.
- Real PostgreSQL 16 and exact combined-head CI. This PASS is not production readiness, security sign-off, or evidence that arbitrary lock schedules cannot deadlock.

## Boundaries

Synthetic UUID identities, fabricated consent fingerprint and test-only Cookie bearer. No external Telegram, PII, payments or production routes. All queries delegate to a real PostgreSQL PoolClient; instrumentation only pauses the test. On failure test connections are rolled back and synthetic fixtures cleaned. No backend, workflow or existing QA source changed.
