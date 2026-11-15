# Cookie F1 — reliable transactional outbox / worker contract (Issue #19)

**Status:** internal engineering slice, no real tenant traffic, PII, SMS/Telegram provider, payments or production worker enabled. Architectural baseline: [F0 contracts](../architecture/f0-contracts-and-invariants.md), [runbooks](../operations/pilot-operational-readiness.md). Source: `packages/platform-db/src/outbox.ts`, migration `0003_outbox_jobs.sql`.

## Delivery guarantees
- A producer calls `enqueueOutbox(client, event)` using the **same PostgreSQL transaction** as its authoritative domain write. A rollback removes both the domain mutation and event; commit makes the event available to the worker.
- Unique `(tenant_id, dedupe_key)` prevents duplicate event rows within one Organization. Reusing a key with different `topic/payload/maxAttempts` is rejected. Reordered JSON object properties produce the same fingerprint. The same key in another tenant is independent. Dedupe key is producer-supplied and must be stable across retries; the first event's delivery schedule is retained.
- Trusted background worker calls `claimOutbox` using PostgreSQL `FOR UPDATE SKIP LOCKED` and a bounded lease. It can process multiple tenants **only in trusted worker infrastructure**; never expose this cross-tenant claim API to customers, browser callers, Telegram or AI tools.
- Each claim increments `attempts` and returns a fresh unpredictable fencing `leaseToken`. `acknowledgeOutbox`/`failOutbox` require the current unexpired token. An expired lease can be reclaimed with a new token. If the final attempt expires without a result, it becomes `dead` (not silently lost).
- Explicit failures return the item to `pending` with bounded jittered exponential backoff; after `maxAttempts` it becomes `dead`. Only sanitized failure **codes** are persisted; raw thrown errors (which could contain secrets) are discarded. Dead rows remain inspectable for a future permission-checked operational replay workflow; no automatic infinite retries.
- `runOutboxBatch` is an **opt-in one-pass runner with injected handler**. There is no scheduled worker, external transport, UI, provider secret or real notification delivery in this PR.

## Hard limits / tradeoffs
- `topic` is a dotted identifier; JSON payload must be a plain object and at most 16 KiB; 1–25 maximum delivery attempts; max 100 claims/batch, leases 1–600000 ms; maximum retry delay one hour. Versioning/schema validation of individual event topics remains the responsibility of producers/consumers.
- **At-least-once, not exactly-once:** if a worker crashes after a provider accepted an event but before `ack`, the lease expires and the event may be sent again. Each eventual provider adapter needs a stable provider idempotency key (prefer event ID), dedupe where supported, an explicit retry/timeout policy and observability.
- No external network call while holding the domain DB transaction. Booking state remains committed even if a notification provider fails. A delayed notification must never roll back or duplicate an authoritative Booking.
- `payload` may contain sensitive fields in future designs, so real content format, retention, encryption, least-privilege DB roles, redaction and RF PII/legal requirements remain **blocked before real pilot**. Tests use synthetic IDs and no genuine contacts.
- Missing: durable worker service orchestration, operational monitoring/alarming, provider-specific errors and message consent, replay/admin authorization, production backup/restore drill, retention/legal audit, performance tests and real notification adapter.

## Validation
The PostgreSQL integration test checks same-transaction rollback/commit, same-tenant deduplication and mismatch refusal, cross-tenant dedupe independence, simultaneous claims without duplicate leases, lease expiry/fencing, retry to dead, crash at exhausted last attempt and injected worker failure followed by retry/success. Migration history remains checksum validated. Passing CI proves the **internal code slice**, not successful delivery to Telegram/SMS or readiness for production.

## F1 synthetic restore smoke (separate follow-up PR)
`scripts/ci-restore-smoke.sh` verifies PostgreSQL 16 logical dump and restore into an isolated second database, including restored migration history, an Organization/outbox event and the event dedupe unique index. It is gated on the exact CI synthetic database address. Any recorded CI PASS is **only** this bounded test, not an operational production backup/restore guarantee; offsite encrypted backups, failure drills and RPO/RTO remain future pre-pilot gates.
