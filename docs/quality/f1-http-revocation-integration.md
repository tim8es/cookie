# F1 HTTP + Policy Revocation compatibility gate

**Status: PROPOSED security integration; synthetic PostgreSQL-only; no release approval.**

This branch is stacked **after Draft [#116](https://github.com/tim8es/cookie/pull/116)**, which itself depends on #110 → #104 → #102 → #100. It is a **reviewable composition of two independent security changes**, not a merge of either:

- [QA #109](https://github.com/tim8es/cookie/pull/109) — deterministic PostgreSQL revocation race regression for CreateBooking, RescheduleBooking and CancelBooking. Its baseline is RED without the fix.
- [Fix #114](https://github.com/tim8es/cookie/pull/114) — PostgreSQL `FOR SHARE` policy row synchronization; separate cross-tenant policy-lock regression. Its original composed head passed [CI #43871255288](https://github.com/tim8es/cookie/actions/runs/43871255288).

## Compatibility method

The content of `packages/platform-identity/src/postgres.ts`, `apps/api/test/booking-revocation-race-qa.integration.test.ts` and `apps/api/test/policy-revocation-locks-qa.integration.test.ts` is copied **unchanged** from #114's exact known-green head `5cfd81d06e71260eb3c47879311a58d24e3ef450`; the baseline policy file in #116 was verified identical to current `main` before porting.

The CI suite composes this lock fix with the existing opt-in synthetic F1 HTTP integration harness, including actual `127.0.0.1:0` loopback requests and PostgreSQL booking commit/replay/conflict tests. No public listener or production AuthN is enabled by this integration.

Required CI evidence before declaring compatibility:

1. All three #109 race cases pass **without any deleted/disabled/relaxed assertions**.
2. #114 row-lock and tenant independence test passes.
3. #116 HTTP loopback tests and all other PostgreSQL/TypeScript/build checks remain green.

## Security behavior

Every `requireTenantPermission` call on a managed PostgreSQL transaction first locks the Organization, current Membership, role assignments and linked roles in a fixed order. An administrative revoke of a referenced row cannot COMMIT while the guarded command is still in progress; if it committed beforehand, the command reads the disabled state and denies. The lock lives **only until transaction COMMIT/ROLLBACK**, so callers must not use a one-statement auto-commit preflight before a separate mutation.

## Outstanding review

- This integration branch duplicates the **exact source of #109/#114 for compatibility verification**. At consolidation, keep one canonical implementation and regression test source; do not merge duplicate patches blindly or inadvertently omit the security fix.
- Cross-role/multi-role grant/revoke concurrency, admin update ordering and potential deadlocks under load still require review.
- Production credential verification, Identity↔Customer ownership, trial/paid entitlement, customer deadline policy, F2 Quote/promotions, API/web E2E and public launch remain **not implemented/not approved**.
- Does not alter `apps/web/**`, launch real channels, connect providers, use personal customer data or merge any PR.
