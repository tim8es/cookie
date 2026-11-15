# F1 — private Outbox alert delivery runner (partial #19 / #38)

**Status:** internal infrastructure library and synthetic PostgreSQL tests.
This module is not a production daemon, real notification provider, active
on-call delivery service or API. No real customer data or outbound network
channels are enabled.

## Purpose and boundaries

The existing alert infrastructure already persists an immutable alert
transition, atomically enqueues its delivery work, allows one worker to claim
a lease with a fencing token, supports ACK/fail/retry, offers a bounded manual
dead-letter replay command and a 15-minute cap for lease renewals. None of
those pieces previously supervised a callback's execution, its deadline or
graceful shutdown.

`packages/platform-db/src/outbox-alert-runner.ts` introduces the **opt-in**
`superviseOutboxAlertDelivery(pool, handler, options)` library. Importing
it does not create a timer, open PostgreSQL, register a signal handler or
launch a worker. A caller explicitly provides a trusted server-side Pool,
a mandatory handler callback and an AbortSignal. The handler is an
application-controlled port receiving only sanitized alert transition
metadata and the stable `outbox-alert-transition:<id>` idempotency key.

**There is no default handler**, no SMS/Telegram/email provider adapter,
no browser access or public HTTP endpoint. This runner is not enabled by
normal API startup or the synthetic Booking worker.

## Lifecycle and failure rules

- **Single flight per process:** claim just **one transition per cycle**.
  There is no speculative claim of a batch whose leases could expire while
  waiting behind a slow callback. Multiple processes remain coordinated
  by the existing PostgreSQL `FOR UPDATE SKIP LOCKED` claim semantics.
- **Bounded handler:** a configurable timeout is required to remain below
  the lease duration (with a technical 100 ms reservation for fenced
  ACK/fail). The default is 20 seconds of callback time with a 30-second
  lease. Technical timeouts are NOT product SLA approvals. The runner
  passes an AbortSignal to the handler.
- **Successful callback:** ACK only through the current PostgreSQL lease
  token. An ACK refused by the database is classified `stale`, not
  delivered; the runner cannot override a newer lease.
- **Rejected callback:** fail with fixed `HANDLER_FAILED` code, never
  store the exception body, and use a bounded retry delay. Existing
  `max_attempts` and dead-letter rules remain authoritative.
- **Timeout:** abort the callback signal, **do not** ACK or requeue the
  potentially still-running callback, and terminate this runner.
  The lease expires naturally and can be taken over with a fresh fencing
  token. JavaScript AbortSignal cannot forcibly stop a callback that ignores
  cancellation; consequently, a late external effect may still occur.
  A future provider MUST verify durable provider-side deduplication using
  the stable idempotency key. Exactly-once external effects are **not**
  claimed.
- **Graceful stop:** after an external AbortSignal, stop new claims. If
  a callback is already running, allow it to finish under the same
  deadline and persist ACK/fail before returning; if it exceeds the
  timeout, stop fail-closed as above. Aborting while a DB claim is still
  executing may leave a newly leased but unprocessed row; it will be
  reclaimed after expiry.
- **Storage outages:** catch errors from claim/ACK/fail, back off and stop
  after a bounded consecutive count. Observers get only aggregate counts
  and the observation type (`cycle`, `storage-error`, `stopped`),
  never transition IDs, lease tokens, SQL, credentials or callback errors.
  Broken observers cannot crash or acknowledge queued work.
- **Operator ownership:** handler creation, worker process lifecycle,
  least-privilege DB roles, query cancellation, transport audit and
  production monitoring require separate review. This library does NOT
  implement an automated real-alert delivery job.

A callback may only depend on reviewed internal infrastructure. It must
not accept client-supplied URLs, contact data or arbitrary destination
identifiers via these alert records. Even a trusted caller must not connect
real external providers in F1 without owner authorization.

## Verification

- Unit tests: no work after stop, invalid options fail before SQL,
  callback exception recorded only as fixed retry reason, observer errors
  ignored, graceful drain acknowledges current task exactly once, hanging
  callback times out without ACK, and consecutive storage errors fail
  closed without secrets.
- Real PostgreSQL 16 integration: two independent Pool-backed runners
  process four synthetic journal transitions **once each**; a synthetic
  handler failure retries the original idempotency key and ACKs exactly
  once; an uncooperative handler is abandoned without ACK, its lease
  expires, a new claim rotates the token, and its late resolution cannot
  affect the new holder.
- No migration is introduced. Existing PostgreSQL migration/restore smoke,
  unit/integration suite, worker SIGTERM smoke and API/web builds remain
  mandatory GitHub CI gates.

**Remaining issues:** external provider-side idempotency guarantees,
real transport adapters, operator AuthN/least privilege, no-PII deployment
policy, production process supervision and runbook, query timeouts,
backoff/alerting policy based on measured SLO, and live pilot approval.
Issues #19 and #38 remain OPEN.
