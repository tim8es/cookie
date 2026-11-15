# F1 — durable Outbox alert transition delivery queue (partial #19 / #38)

**Status:** internal infrastructure code and synthetic PostgreSQL 16 tests.
No SMS/Telegram/email integration, commercial rollout or real customer data.

This follows the [durable Outbox alert journal](f1-outbox-durable-alert-journal.md).
Migration `0016_outbox_alert_delivery.sql` adds a separate delivery-state
table keyed to immutable journal transition ID, leaving the original
`0015` journal history intact.

## Queue lifecycle

A PostgreSQL `AFTER INSERT` trigger puts each new journal transition into
`cookie_jobs.outbox_alert_delivery` **in the same transaction**.
A failed producer transaction creates neither a committed journal transition
nor a delivery row. On migration, existing committed journal transitions
receive one pending delivery row; no external delivery is started.

Each row has bounded attempts, retry availability, leased status/expiry,
cryptographically random lease token, delivered timestamp and a sanitized
failure reason code. `pending → leased → delivered` or
`leased → pending` after a retryable failure; exhausted attempts become
`dead`. These statuses are delivery metadata, **not edits to the
append-only reason-change journal**. PostgreSQL checks and partial claim
indexes constrain the states.

New private worker primitives in
`packages/platform-db/src/outbox-alert-delivery.ts`:

- `claimOutboxAlertDeliveries(pool, {batchSize, leaseMs})`: shared
  PostgreSQL row locking via `FOR UPDATE SKIP LOCKED`, claims the oldest
  due pending or expired lease, bumps attempts and issues a new random
  fencing token. If an expired lease has exhausted allowed attempts, it
  becomes dead-letter; no infinite retries.
- `acknowledgeOutboxAlertDelivery(pool, lease)`: accepts only the **current,
  unexpired leased token**. Duplicate, expired and superseded acknowledgments
  return false; only the accepted transition becomes delivered.
- `failOutboxAlertDelivery(pool, lease, code, delayMs)`: same fencing;
  validates a strict uppercase reason code and bounded delay. If attempts
  remain it requeues the item; otherwise sets dead-letter. Raw exception
  text, credentials and user contact information are never stored.

Lease metadata includes **only** journal revision, alert code, transition
kind/severity, attempt count, transition ID and a stable
`outbox-alert-transition:<id>` idempotency key. No tenant, payload or
customer identity is queried or returned.

## Safety and observable guarantees

This yields **at-least-once eligibility**, not guaranteed exactly-once
external effects. If a handler accepts an alert but the worker crashes
before durable acknowledgment, the next claim may deliver again. A future
provider adapter MUST independently verify durable provider-side dedupe
with the stable transition key; if it cannot, delivery may duplicate.

No network delivery or notifications run in this slice. A future isolated
worker process, external provider review and operator consent must
precede real notifications. The caller is responsible for finishing a
handler before its lease expires or introducing bounded renewal/timeout
mechanisms. Database roles must limit direct SQL mutation of delivery rows.

Expired leases transition to dead on the next claim attempt, not
automatically on a separate background timer. Dead-letter replay, alert
priority, retention, operator acknowledgment and transport failures are
future reviewed workflows. This queue itself is not a public API, does
not connect browser clients or deliver notifications to customers.

## Validation

Real PostgreSQL 16 integration tests create four journal transitions and
verify the trigger creates exactly one pending delivery per transition.
They roll back a journal INSERT and confirm that its delivery row also
rolls back. Sixteen competing claims from two independent pools obtain
four unique leases, never duplicate work. Tests check success/duplicate
acknowledgment, explicit retry, token rotation, stale-fencing rejection,
stable idempotency key, final-attempt dead-letter and crash/lease-exhaustion
dead-letter. Invalid metadata must be rejected before SQL. The old
journal regression now cleans its synthetic delivery rows first; migration
count and synthetic PostgreSQL backup/restore smoke verify the new schema
and trigger.

**Still OPEN:** real alert delivery adapters, provider idempotency,
production worker lifecycle, authorization/DB roles, actual paging and
incident-routing policies, alert retention and approvals, signed
runbooks/SLOs, security/legal review and live pilot authorization.
Issues #19 and #38 remain open.
