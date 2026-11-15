# Cookie F1 — trusted Outbox supervisor and queue metrics

**Scope:** incremental #19 implementation, **synthetic/integration only**. No production process, timer, Telegram/SMS provider, API endpoint, subscription, payment or personal data has been enabled. Source: `packages/platform-db/src/worker.ts`; underlying delivery contract: [Outbox](f1-outbox.md).

## Worker lifecycle

`superviseOutboxWorker(runOnce, {signal, ...})` polls an injected batch handler until an `AbortSignal` is set. A graceful stop **stops future claims** and waits for the currently in-flight batch to finish. On a database/claim failure, it retries with bounded polling delay and stops with a **sanitized** error after a configurable maximum number of consecutive errors (default five). A successful poll resets that counter.

`runTrustedPostgresOutboxWorker(pool, handler, options)` is an opt-in bridge to the existing PostgreSQL `runOutboxBatch` engine. It **claims one event per batch**, not ten: a long handler on the first of ten preleased events could otherwise let later events expire before they start processing. Until a lease heartbeat/renewal and cancellation contract is implemented, this conservative throughput limit is intentional.

**Failure boundaries:** the handler must be idempotent, implement bounded external request timeouts and finish before the configured lease where possible. If a handler is stuck forever, graceful stop can also remain pending. If the handler completes after lease expiry, its acknowledge is rejected; another worker can legitimately retry. That is at-least-once, **not exactly-once delivery**. Neither successful delivery to Telegram nor a real worker deployment is claimed.

## Observability

`readOutboxQueueMetrics(pool)` returns a PostgreSQL aggregate (pending, due, leased, expired leases, delivered, dead, oldest due age) with **no tenant identifiers, payloads, phone numbers, tokens or messages**. Metrics are internal operational data across all tenants; never expose this SQL/port to customers or unauthenticated API calls.

`observe` callback receives only aggregate batch counters and worker state (`batch`, `poll-error`, `stopped`) and consecutive poll-error count. Its exceptions cannot acknowledge, drop or interrupt queued jobs. Infrastructure exception details are never included in observations. Alarm thresholds, incident ownership, instrumented logger, monitoring endpoint authorization and retention are **not implemented**.

## Tests and deliberate gaps

Unit tests simulate abort-before-start, abort-in-flight, transient and consecutive poll failures, faulting metrics callbacks and invalid configuration. A separate PostgreSQL integration test enqueues one synthetic event, reads safe aggregate metrics, runs the single-event worker and verifies delivered state. Database integration files run sequentially in CI to prevent independent synthetic workers from claiming one another's fixtures.

Before a real pilot: provider-specific idempotency, API rate/timeout controls, handler isolation, heartbeats/lease renewal, authorized dead-letter replay, long-running process hosting and health checks, external monitoring/alerting, least-privilege database role and DB hardening, encrypted operational backups, GDPR/RF PII/legal review where applicable. **Issue #19 remains open.**
