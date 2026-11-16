# F1 #150 — authoritative Outbox lease check before handler start

**Status:** internal synthetic-only lease safety repair, stacked onto worker
PR #143 together with independent QA regression PR #148. No live transport.

## Failure and correction

A PostgreSQL claim starts its lease using the database clock. The previous
bounded worker started its timer only **after** the claim promise resolved.
A delayed response/result dispatch could therefore return an already-expired
lease, yet the worker would still invoke the handler. Database fencing on
ACK/fail would reject a stale completion but **could not undo an external
effect** from an already-started handler.

The bounded `runTrustedPostgresOutboxWorker` now performs a conditional,
current-fencing-token PostgreSQL UPDATE **after** receiving the claim and
**before** calling any handler:

- Requires the same event ID and lease token, `status='leased'` and
  `lease_until > clock_timestamp()`, all checked in the database.
- If currently valid, atomically refreshes the lease deadline to the
  configured `leaseMs` from the database clock, ensuring the handler's
  timeout window fits the new lease.
- If expired, superseded or aborted, **no handler starts** and no ACK/fail
  is written. The worker stops with the existing sanitized
  abandoned-lease error. The row can be reclaimed by a new worker after
  expiry using a new fencing token. Storage errors remain handled through
  the supervisor's bounded error circuit.
- No raw query errors, tokens, tenant data or event payloads are sent to
  observers. The no-timeout legacy API is unchanged.

The refreshed lease can modestly delay crash recovery; it is still bounded
by the existing validated 1–600000 ms `leaseMs`. There is **no claim** of
exactly-once provider effects: even an approved handler may continue after
lease expiry if it ignores abort. External provider-side idempotency remains
required.

## Evidence / integration

The exact, unchanged real PostgreSQL 16 QA regression from PR #148 holds
the **completed claim result** in an adapter while another connection
expires the database lease, then releases the result. It must assert
`handlerStarts===0`. This test is intentionally RED on parent #143,
confirmed by QA CI, and is included unchanged in this stacked integration
branch. All existing timeout/recovery and CI tests must also pass.

No migrations, Booking/Identity/front-end changes, external SMS/Telegram
provider, payments, PII or production deployment. Parent #143 and QA #148
remain separate PRs pending human review, and Issue #19 remains open.
