# F1 independent QA: stale Outbox lease returned to worker after claim

**Scope:** deterministic real PostgreSQL 16 regression against PR #143's proposed bounded worker; test-only change. No live delivery, provider or production change.

## Invariant and hypothesis

The proposed worker starts a handler timeout **after** `claimOutbox(pool)` resolves. PostgreSQL starts the lease clock when it commits the claim. An adapter delay (network/result dispatch/event-loop scheduling) between these operations can consume the whole lease. Even though the configured `handlerTimeoutMs + 100 < leaseMs`, the handler may begin on an already-expired lease. A second worker could legally reclaim it, and database fencing only prevents the first worker from ACKing, not duplicate effects.

The safe behavior is **no handler invocation** when the lease returned to the worker is already expired. A safe implementation may fail closed and stop the worker or decline processing the stale result.

## Deterministic reproducer

`apps/api/test/worker-stale-claim-qa.integration.test.ts`:
1. Insert synthetic tenant, identity and `test.synthetic` Outbox event using the real PostgreSQL 16 database.
2. Wrap only the worker's `Pool.query` adapter; execute the real `claimOutbox` SQL, then hold the returned result **after** SQL completion. Signal a synchronous checkpoint.
3. From an independent DB connection, set the existing leased event's `lease_until` to DB-clock past (simulates an arbitrarily delayed returned claim, **without** random sleep).
4. Release the result and assert that the external handler was **not** started.

Current PR #143 has no authoritative `lease_until` check between claim completion and handler invocation. The new test should be **RED** against that head; that red result documents a real invariant violation under the forced interleaving, not a production incident.

## Evidence

- Stacked base: [PR #143](https://github.com/tim8es/cookie/pull/143) head `9e8f26af824c85e1db2dcc2a66696648b1166d0f`.
- PostgreSQL 16 exact command:
  `TEST_DATABASE_URL=postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci pnpm exec tsx --test apps/api/test/worker-stale-claim-qa.integration.test.ts`.
- Mandatory full workflow: `.github/workflows/f1-ci.yml`; do not mark PASS if the regression fails.
- Release gate: backend/DevOps must adjust the lease contract and independently green this test **without** disabling, skipping or weakening the assertion; then run all prior worker, Booking and PostgreSQL CI tests.

**Not proven:** that any current real provider duplicates messages. The current worker is synthetic only and #19 remains open.

## CI execution tracking

The QA PR targets the feature branch of #143 (stacked QA-only diff). Its first head was `6a65565c862be65e762775ffb922c3648ecab495`. The GitHub Actions run must explicitly report this QA head or a later head before interpreting the test; successful CI for parent PR #143 cannot validate the added assertion. If GitHub does not trigger checks for this stacked PR, report **NOT RUN / CI BLOCKED** and ask the platform owner to enable a safe test runner for this branch, rather than falsely using parent CI as proof.

### First CI attempt

- [GitHub Actions #43894035951](https://github.com/tim8es/cookie/actions/runs/43894035951) on QA commit `2783b522cbc969aefb0a56fcb20edac9ca348207`: **FAIL — Prettier formatting only**. The PostgreSQL regression never executed. This is not RED security evidence. The QA branch must remove any temporary formatter diagnostic workflow changes before review/merge.

## Verified red integration regression

**Confirmed defect — High / [Issue #150](https://github.com/tim8es/cookie/issues/150).**

- Real PostgreSQL 16 [Actions run #43895489776](https://github.com/tim8es/cookie/actions/runs/43895489776), exact source SHA `b98e2d3ed325143359c7058bae6ed3156724d3c4` (QA branch based on PR #143 head).
- **PASS:** lint, read-only Prettier check, module boundaries, TypeScript and unit checks preceding integration; Prettier verified test source unchanged.
- **FAIL:** `apps/api/test/worker-stale-claim-qa.integration.test.ts:132` in real-PG integration: `AssertionError: 1 !== 0` (`handlerStarts` actual **1**, expected **0**). A timed-out/expired lease can still be dispatched.
- Reproducer uses committed claim, independent DB-clock expiry, delayed result callback; no sleep or real provider.
- **Expected red** until backend/worker fixes source; the CI failure is deliberate evidence of an invariant violation, not approval to skip or weaken the test.
- A temporary QA-only formatter-diagnostic step was used to learn the exact Prettier diff; it was **removed together with its temporary QA push trigger before the final PR diff**. CI on the final cleanup commit must not be presumed PASS or RED without a matching run.

The test must stay red for the vulnerable source and become green on a fixed source. The feature PR #143's older full CI PASS does not cover this newly added regression.
