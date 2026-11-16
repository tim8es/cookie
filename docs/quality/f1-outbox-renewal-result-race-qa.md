# F1 independent QA — lease renewal response race after #150 fix

**Status: NOT RUN at authoring.** This is a second, distinct PostgreSQL 16 deterministic concurrency probe stacked on the #155 fix candidate. Only QA test and documentation changed.

## Invariant

After an Outbox worker receives a lease and renews it with its fencing token, that worker must not **begin** the external handler if the lease has expired and another worker has already reclaimed the same event using a fresh fencing token.

A claim-side revalidation alone does not prove this: the renewal SQL result itself can be delayed after PostgreSQL COMMIT, before Node schedules the handler. The token might become stale in the gap. Database fencing prevents stale ACK but cannot reverse a provider side effect.

## Interleaving / reproducer

1. A synthetic `qa.renewalrace` event is inserted in real PostgreSQL 16.
2. The test's query adapter executes the actual #155 `UPDATE ... SET lease_until=clock_timestamp()` renewal and **holds only its already-committed result**. No DB row lock is retained.
3. Independently, expire that lease using the DB clock, then call the real `claimOutbox` with another connection. Require the same event ID and a **different** fencing token.
4. Release the first worker's delayed renewal result.
5. Assert its handler invocation count remains **zero**. The test callback aborts the worker if unexpectedly invoked, so a vulnerable implementation cannot run indefinitely.
6. Cleanup all synthetic rows in `finally`.

This tests a distinct interleaving from the original #148 test: **claim → renewal → delayed renewal response → reclaim → first handler**. No sleeps, no production provider.

## Reproduction

- Source: `apps/api/test/worker-renewal-result-race-qa.integration.test.ts`.
- Base: [PR #155](https://github.com/tim8es/cookie/pull/155) commit `cc1f174677b41a651de0f5f73981f2ae261919d1` (already includes previous #148 regression).
- `TEST_DATABASE_URL=postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci pnpm exec tsx --test --test-concurrency=1 apps/api/test/worker-renewal-result-race-qa.integration.test.ts`.
- Full F1 CI with PostgreSQL 16 required. Never mark a suspected RED test as a confirmed defect before inspecting exact-head logs.

## Limits

An adversarially held query-result delivery demonstrates a possible loss of lease authority, **not** actual SMS/Telegram duplication. The problem may require stronger lease ownership/fencing semantics or approved provider idempotency instead of a narrow extra preflight check. Backend owner must evaluate without changes by QA to production code. No deployment, payments, real customer data or pilot.

Related: #150, #19, #143, #148, #155.
