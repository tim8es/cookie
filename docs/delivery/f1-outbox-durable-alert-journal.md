# F1 — durable singleton Outbox alert journal (partial #19 / #38)

**Status:** engineering-only implementation on isolated synthetic PostgreSQL 16.
No customer or tenant-facing endpoint, real delivery provider, production
on-call alerting, credential, paid connector or live customer data.

## Why and architecture

The earlier in-memory [Outbox alert monitor](f1-outbox-alert-monitor.md)
suppresses repeated alerts only until restart. Two separate instances can
independently emit the same reason if they keep separate memory. This slice
adds **one shared PostgreSQL source of truth** for the **global** Outbox
monitor, in immutable migration `0014_outbox_alert_journal.sql`.

- `cookie_jobs.outbox_alert_state`: a single boolean-keyed row, initialized
  during migration. Stores only the active reason-code/severity map,
  monotonically increasing revision and update timestamp. There is
  deliberately **no tenant ID**, customer contact, message payload, request
  metadata or arbitrary free-form text.
- `cookie_jobs.outbox_alert_transitions`: append-only logical journal with
  identity ID, revision, code, kind and optional previous/current severity.
  PostgreSQL checks prevent invalid severity transitions and
  `UNIQUE(revision,code)` prevents duplicates within a revision.
- `reconcileOutboxAlertsDurably(pool, policy)` in
  `packages/platform-db/src/outbox-alert-persistence.ts`: validated
  trusted operator thresholds, **one transaction** holding
  `outbox_alert_state FOR UPDATE`, fresh aggregate queue query,
  `evaluateOutboxHealth` + `reconcileOutboxAlerts`, optional state
  update and append journal entries, then COMMIT. The procedure returns only
  newly committed transitions, current state, status and revision.
  It **does not call** an external notification provider.

**The order matters:** read queue metrics *after* acquiring the singleton
row lock, rather than computing a snapshot before the lock. This prevents
an old snapshot from a slower replica being applied after a newer replica's
reconciled state. Queue producers/consumers are not locked by this sampler;
a subsequent poll observes their changes.

All monitor instances must use **the same database**. Transactions serialize
on the singleton; a concurrent request sees the state committed by its
predecessor and emits no duplicate transition for an unchanged condition.
A restart creates a fresh connection but uses the persisted state. If the
transaction fails at any point, neither its state update nor any journal
entries are committed. Low-level DB errors are replaced by one fixed
operational error message, not logged with credentials or event data.

The SQL uses fixed internal technical `lock_timeout=3000ms` and
`statement_timeout=7000ms` to fail closed on contention/stalls. These are
not product SLO values. Caller is still responsible for connection timeout,
Pool lifetime, query budgets and incident triage. An offline database cannot
store an `METRICS_UNAVAILABLE` transition in that same database; existing
state remains durable and a separate outside-DB watchdog remains necessary.

## What this does **not** guarantee

**One durable transition per observed state change is not exactly-once
external notifications.** No sender/claim/ack API is introduced here;
no real alert delivery happens. A future notification worker must claim
journal rows with lease/fencing, retain stable provider idempotency keys,
track delivery/ack, handle retries and implement a reviewed incident
retention/privacy policy. Strict transport exactly-once cannot be promised
without provider guarantees. No production monitor process, public API,
tenant metric access, replication leader, alert destination or operating
runbook is activated.

This global queue-monitor singleton intentionally does not assign tenant
identities to alert signals. Operators must keep these aggregate metrics
and even code/severity metadata behind privileged operational access.
Any future per-tenant alert feature needs a separately reviewed policy and
schema; do not reuse this singleton for customer-facing monitoring.

## Verification

Real PostgreSQL integration test creates a synthetic Organization/event,
then races **20 concurrent reconciliations from two separate Pool instances**.
Exactly one transition is committed. A third Pool simulates a restart and
produces no duplicate. When the event becomes dead-letter, a temporary
test-only trigger raises at journal insertion **after the state UPDATE**;
the entire transaction rolls back and a healthy retry commits the proper
resolution + new alert once. Removing the dead event commits exactly one
resolution. All fixtures, test triggers and singleton changes are cleaned
from CI's disposable database. The immutable migration is included in
migration-count checks and in the CI dump/restore table verification.

**Still OPEN:** actual durable delivery claims, alert transport/ack/retry,
multi-replica monitoring lifecycle, external watchdog for DB outages,
operator threshold decisions, security/least-privilege roles, load/SLO
measurements, production deployment and real PII/pilot approval.
Issues #19 and #38 are not closed by this slice.
