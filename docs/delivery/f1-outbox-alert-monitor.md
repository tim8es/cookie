# F1 — private Outbox alert transitions and bounded sampling (partial #19 / #38)

**Status:** internal engineering, synthetic-only. This is not a production alert
service, on-call integration, external messenger integration or public API.

This slice builds on [F1 private Outbox health evaluation](f1-outbox-health.md)
without modifying the original worker, Outbox processing, Booking, API or UI.
Code lives in `packages/platform-db/src/outbox-alert-monitor.ts`.

## Stateless reconciliation with explicit state transfer

`reconcileOutboxAlerts(previousState, healthSnapshot)` is a deterministic,
side-effect-free transformation. The caller owns the `OutboxAlertState`
and each call returns a **new state** and a list of sanitized transitions:

- `raised`: reason first exceeds the explicitly configured threshold.
- `escalated` / `deescalated`: warning/critical severity changed.
- `resolved`: a previously raised reason is absent from a **valid**
  subsequent sample.

Every transition includes only a code and current/previous severity, not
queue data, tenant identifiers, SQL errors, event IDs or notification text.
Unchanged reasons emit no additional transition. The order is stable.

**Important invariant:** an unavailable metrics database is not evidence of
recovery. A sample carrying `METRICS_UNAVAILABLE` adds one critical outage
signal without resolving any previously active due/dead/lease/age findings.
Repeated outages emit no duplicates. On recovery a valid sample updates
real queue findings and separately resolves the outage signal. Invalid or
contradictory samples throw rather than clearing active alert state.

The state is **in-memory and process-local**; it does not survive a restart
or support reliable cross-replica dedupe. A future durable operator/alert
state store with leader election/fencing is needed before enabling on-call
delivery. The returned immutable-by-contract state can be checkpointed by
a future explicitly reviewed persistence adapter.

## Explicit, bounded polling supervisor

`superviseOutboxHealth(options)` is an **opt-in** loop that never starts on
module import. The trusted caller provides a one-shot sampler, usually
`sampleOutboxHealth(pool, policy)`, and an `AbortSignal`. Optional technical
bounds: `intervalMs` (default 1,000), `sampleTimeoutMs` (default 5,000) and
`maxConsecutiveUnavailable` (default 5), all validated within bounded
ranges. These defaults are polling safety controls, **not product SLOs**.

- **Single flight:** samples are sequential. No new request begins until
  the previous one returns. If a sample exceeds its timeout, the loop
  stops with a generic error instead of issuing overlapping reads.
- **Graceful stop:** abort cancels pending delay and suppresses a delayed
  sample response; no more alerts are emitted after shutdown.
- **Bounded outage:** repeated unavailable samples emit one critical signal
  and stop the loop after a fixed configurable count.
- **Best-effort observers:** callbacks receive reason codes/severities or a
  status word only; errors thrown by callbacks cannot interrupt the loop.
- **Fail closed:** invalid configurations, contradictory samples, rejected
  sampling calls and timeout errors reject without exposing driver errors,
  credentials, raw SQL, message payloads or customer data.

A JavaScript timeout **does not cancel the underlying PostgreSQL query**.
A real operational Pool must separately enforce database query timeouts and
connection limits. An abandoned underlying promise could still complete
after the supervisor has halted; it cannot emit alerts or initiate another
poll. No external delivery provider is called here.

## Test evidence

Unit tests cover deduped warning/critical transitions, escalation,
deescalation and resolution, two simultaneous reasons, no false recovery
during an outage, invalid sample fail-closed handling, single-flight sampling,
shutdown, observer exceptions, bounded outages, unresponsive samples and
non-leaking sampling failures.

Real PostgreSQL 16 integration test creates synthetic due and future events,
changes due into dead letter via the existing Outbox lease/failure API and
removes the dead event after a synthetic operator triage. It asserts exactly
one raised/resolved transition per reason, no duplicate unchanged alert,
and preservation of the unrelated future event.

## Remaining release gates

No public or tenant-facing metrics, production deployment, durable state,
multi-process dedupe, cross-replica leader lease, alert destination or paging
provider, guaranteed delivery, acknowledgement workflow, real-time on-call
routing, validated operational thresholds, cancellation of database I/O,
real AuthN, PII/security/legal clearance or commercial pilot.
**Issues #19 and #38 remain OPEN.**
