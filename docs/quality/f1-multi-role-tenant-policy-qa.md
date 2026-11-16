# F1 independent QA: multi-role revocation and tenant-scoped policy locks

**Scope:** real PostgreSQL 16 integration test for policy guards (#113, #18). No production-code, endpoint, schema, session, provider, or release changes.

## Invariants tested

1. A synthetic non-owner identity may hold two active administrator role assignments granting `booking.create` in tenant A and another independent assignment in tenant B.
2. Holding an authorized A policy transaction must serialize a concurrent revoke of its *second* granting assignment until COMMIT; a 350 ms `lock_timeout` must observe PostgreSQL `55P03` rather than a silently committed revoke.
3. An independent revocation of that **same identity** in tenant B commits while A remains locked; B subsequently denies.
4. After A commits, revoking one grant preserves permission through the second active role; revoking both denies. Re-enabling B does not grant A permission.

## Boundaries

This tests the transaction-scoped `requireTenantPermission`/role-union policy layer, not a full Booking domain command, production bearer identity issuer, browser flow, personal data or entitlements. Existing Booking mutation race tests in main cover Create/Reschedule/Cancel separately. This additional regression does **not** establish deadlock freedom for every admin workflow or close #113 by itself.

CI must pass the full existing quality suite and this real PostgreSQL integration before review. All IDs are random synthetic fixtures, removed in reverse FK order. No real users, payments or commercial deployment.
