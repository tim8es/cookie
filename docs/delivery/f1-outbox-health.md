# F1 — private Outbox health evaluation (partial #19 / #38)

**Status:** internal infrastructure implementation on synthetic data.
Not production alerting, a public monitoring route, real delivery, or approval
to process real customer data.

## Goal

The Outbox worker already exposes aggregate PostgreSQL metrics through
`readOutboxQueueMetrics(pool)`. This independently owned slice adds an
operator-controlled **health classification** on top of those existing
metrics; it does not change the worker, SQL migration history, outbox leases,
event schema, delivery policy, platform AuthN, backend Booking code or web UI.

Source: `packages/platform-db/src/outbox-health.ts`.

### Trusted internal interface

- `evaluateOutboxHealth(metrics, policy)`: pure, deterministic classification;
  no database/clock/network side effects.
- `sampleOutboxHealth(pool, policy)`: **single opt-in read** of existing
  queue metrics. It does not start an interval, worker, HTTP endpoint or
  external alerting provider. A caller must provide a trusted server-side
  Pool; it is not available to browsers or customer-supplied AI tools.
- `OutboxHealthPolicy`: four **mandatory, explicit** pairs of
  `warning`/`critical` thresholds for:
  - `due` — number of pending events already eligible for delivery;
  - `oldestDueSeconds` — age of the oldest due event;
  - `expiredLeases` — count of leases that have expired without ack;
  - `dead` — dead-letter count.
- Values must be finite nonnegative safe integers, `critical >= warning`;
  alerting occurs on **strictly greater than**, so threshold zero detects
  the first event. No product SLA or thresholds are hard-coded as a default.
- Findings have stable, privacy-safe codes:
  `DUE_BACKLOG`, `OLDEST_DUE`, `EXPIRED_LEASES`,
  `DEAD_LETTERS`. The worst severity sets one overall state:
  `healthy`, `degraded`, `critical`.
- Failed DB reads return `unavailable` and only the code
  `METRICS_UNAVAILABLE`. Raw SQL errors, credentials, tenant IDs, event
  payloads, contact details and messages are not included.
  Invalid operator policy or inconsistent counters throw rather than
  misrepresenting a broken monitor as a healthy queue.
- Valid results contain only **global aggregate metrics** (not tenant IDs or
  payloads). Global counts remain operationally sensitive; do not expose
  them to tenant staff, guests, public endpoints or untrusted adapters.

### Important operational interpretation

A dead-letter event remains `dead` until authorized manual replay or
retention action, so health consumers must deduplicate identical alerts.
A brief backlog may be expected during scheduled bursts. Threshold values
and delivery objectives must be chosen from measured demand, worker
throughput and actual commercial SLA, not assumed by this module.
This slice emits **no notifications** and has no provider rate limits,
heartbeat, dead-letter triage UI, durable alert state, retention, approval
workflows or active paging. It is one decision engine for a future
trusted ops agent, not the ops agent itself.

## Verification

Unit tests cover healthy boundaries, warning and critical thresholds,
priority among multiple findings, zero thresholds, invalid policy,
inconsistent metrics, sanitized DB outages and no read on invalid config.
A real PostgreSQL 16 integration test adds tenant-scoped synthetic due and
future events, samples the global metrics, exhausts one synthetic lease into
dead letter, verifies the distinct expected alert codes and leaves the
future event unclaimed. All fixtures are cleaned up.

**Remaining gates:** operator-owned threshold policy, sampling lifecycle,
security/least-privilege DB access, durable alert deduplication and
notifications, production readiness tests, provider delivery semantics,
live AuthN and legal/PII/hosting review. Issues #19 and #38 stay open.
