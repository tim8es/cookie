# F1 lock-order regression — Booking vs Shift edit vs owner policy mode

**Related:** [Security #113](https://github.com/tim8es/cookie/issues/113), [Booking #21](https://github.com/tim8es/cookie/issues/21), [Scheduling #20](https://github.com/tim8es/cookie/issues/20), [Identity #18](https://github.com/tim8es/cookie/issues/18), revocation fix [PR #114](https://github.com/tim8es/cookie/pull/114).

## Hypothesis

The revocation fix in PR #114 introduces transaction-scoped `FOR SHARE` policy row locks (Organization first) for all guarded commands. On `main` the internal Booking creation locks Organization/identity policy rows **before** StaffProfile, while the published-shift edit locks StaffProfile **before** calling `requireTenantPermission`, which now locks Organization. The trusted owner `setScheduleEditPolicyInternal` takes Organization `FOR UPDATE`.

The three concurrently permitted operations can therefore potentially form a lock graph:

1. **Shift edit S** has StaffProfile `FOR UPDATE` and later needs Organization `FOR SHARE`.
2. **CreateBooking B** already holds Organization `FOR SHARE` and waits for the staff row held by S.
3. **Owner mode change O** waits for Organization `FOR UPDATE`, blocked by B. PostgreSQL's waiting-lock queue can cause S to wait behind O's exclusive request, closing S → O → B → S.

This is **a hypothesis until the actual CI integration result is inspected**. A failure is a review blocker, not permission to weaken the assertion.

## Deterministic PostgreSQL 16 regression

`apps/api/test/booking-schedule-policy-lock-cycle-qa.integration.test.ts` creates only synthetic tenant identity/role, staff, service, location and a legitimately drafted/published shift. It uses **real existing domain functions** `editPublishedShiftInternal`, `createBookingInternal` and `setScheduleEditPolicyInternal`.

- A transaction-bound test facade pauses the actual shift edit immediately after its StaffProfile `FOR UPDATE` is acquired.
- CreateBooking starts on an independent PG pool. The test queries `pg_stat_activity` and `pg_blocking_pids` to prove that it is waiting for S.
- The real owner policy-mode change starts on a third pool. The test confirms it waits for B's Organization lock.
- Then S resumes unchanged at the actual shift authorization call. Every branch has a bounded statement timeout. The test detects PostgreSQL `40P01` and fails; otherwise expects all three commands to complete and preserves a Confirmed Booking and incremented shift revision.

No production code, migrations, or workflow changes are included in this independent QA PR. Failures must be classified as actual deadlock vs harness synchronization vs environmental timeout before making a product-security claim.

## Verified CI outcome (2026-11-16)

**PASS:** [GitHub Actions run 43872764301](https://github.com/tim8es/cookie/actions/runs/43872764301) at head `a300dd67ea95d8b50ed9dd8df020f501b6d7a3e0`. The test appears explicitly in the real PostgreSQL 16 integration log as `✔ booking, published-shift edit and owner policy change cannot form a PostgreSQL deadlock` (241.9 ms). It confirmed that the Booking waited for the staff lock and the owner-mode change waited for the Booking's Organization lock before releasing the schedule command; **all three domain commands completed and no PostgreSQL 40P01 occurred**. Booking remained Confirmed and the published shift revision advanced.

This falsifies the *specific orchestrated three-way deadlock hypothesis* in the current PostgreSQL lock-wait behavior; it does **not** prove the absence of all deadlocks under different interleavings, multi-role transitions, maintenance operations or elevated concurrency. Preserve the test as a regression, and review lock order across other scheduling/admin mutation handlers before release.

## Resolution requirements if red

Document and unify mutation lock ordering across Booking, Scheduling and the owner policy-mode editor. Avoid weakening revocation serialization (#113), occupancy/exclusion guarantees (#21), schedule protection (#20) or access-control scope (#18). Prove the fix using the unchanged test; re-run broader PostgreSQL concurrency suite and consider lock-contention metrics/timeout policies before a release.

Do not merge this gate independently into `main` without reviewing the stacked fix branch and all dependent PRs.
