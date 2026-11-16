# F1 independent QA: Outbox handler-start row lock (#150)

**Status:** UNVERIFIED until an exact-head PostgreSQL 16 CI run completes. QA-only stacked regression on backend [PR #166](https://github.com/tim8es/cookie/pull/166). No production source, migrations or workflow changed.

## Risk and invariant

The previous QA [#157](https://github.com/tim8es/cookie/pull/157) proved that a delayed renewal response can allow a stale handler to start. The backend fix in #166 uses an actual PostgreSQL transaction and `FOR UPDATE SKIP LOCKED` to guard the **synchronous** handler invocation. A valid handler must start exactly once while the corresponding event row is locked, and its eventual successful ACK must not be lost.

This regression complements #166's stale-lease test: it verifies that the protection works on the *authorized positive path*, rather than merely causing all handlers to stop.

## Deterministic real-PostgreSQL interleaving

1. Create synthetic Identity, Organization and one pending Outbox event; run actual migrations.
2. Start the bounded trusted worker using a complete adapter with both `query` and `connect` delegated to real `pg.Pool`.
3. Intercept only the real dispatch transaction's `COMMIT` invocation (before the SQL statement executes). The handler has already been invoked synchronously and the `FOR UPDATE` lock must still be held.
4. Start an independent PostgreSQL transaction with `SET LOCAL lock_timeout = '250ms'`. Attempt an `UPDATE` against that event. Require SQLSTATE `55P03` (`lock_not_available`); an unexpectedly committed UPDATE is a hard test failure.
5. Release the guarded COMMIT; assert worker terminates normally, one handler started, one real guarded connection was used, and event is `delivered` with `attempts=1`.
6. Remove synthetic data in `finally`.

No random sleeps. The lock timeout only bounds the rival SQL attempt after explicit checkpoints. External handlers and providers are simulated; the test does **not** prove exactly-once delivery to an external system.

## Reproduce

- Test: `apps/api/test/worker-handler-start-lock-qa.integration.test.ts`
- Parent implementation under review: [PR #166](https://github.com/tim8es/cookie/pull/166).
- PostgreSQL 16 with local synthetic `TEST_DATABASE_URL` and Node 26 / pnpm 10.24.0.
- Targeted: `TEST_DATABASE_URL=postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci pnpm exec tsx --test --test-concurrency=1 apps/api/test/worker-handler-start-lock-qa.integration.test.ts`
- Full: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm test:integration`

## Boundaries and blockers

- Until exact-head CI is green, this QA scenario is neither PASS nor a proven new defect.
- #165 remains confirmed RED on [QA PR #162](https://github.com/tim8es/cookie/pull/162) with [real PostgreSQL 16 CI](https://github.com/tim8es/cookie/actions/runs/43905245695).
- #113 remains open for full authorization and session-revocation safety. #144 remains a branch-governance blocker.
- No production rollout, commercial pilot, real PII, real channel, or payments authorized.
