# F1 #191 — compiled synthetic worker database ACK acceptance

**Scope:** CI-only test harness; no public routes, real providers, real data, production deployment or commercial pilot. This targets the existing `Compiled synthetic worker fail-closed and SIGTERM smoke` step and the genuine built `dist/apps/api/src/synthetic-worker-main.js`.

## Root gap

Before this change, the shell smoke checked three invalid configuration cases, started the compiled worker, slept one second, checked process liveness and sent SIGTERM. The test could pass even if the worker never completed a PostgreSQL poll, never claimed an event and never ACKed it. The library-level PostgreSQL tests cover their own contracts but are not a proof of the compiled CLI wiring.

## New observable acceptance

The shell retains all three original explicit-config fail-closed checks and delegates its success path to `apps/api/test/compiled-worker-delivery-smoke.ci.ts`.

The helper is restricted to `CI=true` and the pinned isolated localhost `cookie_ci` database, without accepting arbitrary URLs. It uses `tsx` **only for fixture setup and DB observations**; the worker process itself is spawned using `node dist/apps/api/src/synthetic-worker-main.js`.

1. Create a synthetic Identity and tenant and transactionally enqueue one uniquely keyed `test.synthetic` Outbox row plus an unrelated `test.unrelated` row. Clean up both rows and their tenant/Identity after the run.
2. Start the compiled worker with `PGSSLMODE=require` against the non-TLS PostgreSQL 16 test service. The process must fail with its sanitized polling-error shutdown rather than pass merely because it remains alive briefly. Before and after, the queued event must remain `pending`, attempts 0 and no ACK.
3. Start the compiled worker again with the supported database connection. Bounded short-interval **database polling**, not a fixed arbitrary sleep, must observe the event transition to `delivered`, attempts exactly 1, `delivered_at` present and lease token cleared. The unrelated topic must remain pending/attempts 0.
4. Send SIGTERM; require clean exit code 0, and re-read PostgreSQL to confirm the exact event is still delivered once and unrelated work was not touched.

The test has finite deadlines and terminates any orphaned child on failure. Its worker never executes external sends: `test.synthetic` is a local no-op handler. No raw tokens, tenant IDs or payload are reported by the test summary.

## Required proof

Require lint, read-only Prettier, TypeScript and **exact-head full F1 GitHub Actions** including migrations/integration, restore, compiled smoke, API/Svelte and Chromium visual evidence. Do not mark PASS until a CI run actually proves the DB ACK and negative SSL failure. Node-postgres honors `PGSSLMODE`; the CI PostgreSQL service intentionally has no TLS configured.

**Limits:** This verifies one real compiled process to DB end-to-end; it does not establish production delivery, provider-side exactly-once effects, high load or admin-protected main. #19/#144 remain distinct gates.
