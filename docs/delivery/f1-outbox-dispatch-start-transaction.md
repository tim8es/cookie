# F1 #150 — transactionally fenced Outbox handler start

**Status:** F1 synthetic-only source repair stacked on [#157](https://github.com/tim8es/cookie/pull/157)
and parent [#155](https://github.com/tim8es/cookie/pull/155).
No real provider, commercial pilot or production deployment.

## Root cause

The independent QA regressions show a lease can be lost between a
successful PostgreSQL statement (original claim **or** renewal) and
its delayed response to the worker. Even a second standalone preflight
query would reproduce the same check-to-dispatch race if its response
were delayed. Database fencing at ACK cannot roll back an already
started provider side effect.

## Dispatch-start linearization

The bounded trusted worker retains its original post-claim renewal,
then obtains an **actual PoolClient and PostgreSQL transaction**.
It selects the original event ID and current lease token with
`FOR UPDATE SKIP LOCKED`, requires status `leased` and an unexpired
PostgreSQL-clock deadline, and refreshes the deadline **within the
same locked transaction**. If any check fails, no handler starts,
no ACK/failure is sent, and this process stops using the existing
sanitized abandoned-lease error.

**Crucial invariant:** the synchronous invocation of the handler
function happens **before COMMIT and while the row lock is held**.
No asynchronous handler work is awaited under the transaction; the
transaction closes and releases its lock immediately after invocation.
The handler timeout covers the invocation and completion. Connection
acquisition, BEGIN/COMMIT, authority-check and rollback failures stop
this claimed worker fail-closed; a COMMIT failure **after** invocation
also aborts the handler signal. An incomplete Pool adapter lacking
`connect` must fail closed, not silently continue polling.

This is a start-linearity guarantee against concurrent PostgreSQL
reclaim, **not a claim of exactly-once external effects**. A handler
that performs an external send after its first `await` may operate
after the lease expires or a later worker claims the event. Providers
still MUST enforce durable idempotency on stable event IDs. Client-side
clocks and additional unprotected rechecks cannot replace this
requirement.

## Real PostgreSQL proof

The new synthetic integration regression uses a full Pool adapter
that implements both `query` and `connect`. It delays the **completed
renewal result**, expires the old token in another connection and
reclaims via real `claimOutbox` before releasing the result.
The old worker must start **zero** handlers; the new branch must
verify the transactional guard was entered (exactly one PoolClient
acquisition), and that the second worker's new fencing token remains
current. This avoids false GREEN caused by a mock missing `connect`.

The independent QA #157 test itself is included unchanged (source
blob preserved). Existing bounded-handler success/timeout/recovery
and full PostgreSQL 16 CI must remain green.

No migration, ordinary/alert maintenance, Booking, Identity, frontend,
real outbound channel, secrets, payments or actual customer data.
Parent worker PRs must not merge without the corrected safety contract
and review. Issue #19 remains open for provider-side idempotency and
operational gates.

## Consolidated current-main F1 CI gate (2026-11-16)

This leaf PR now targets `main` exactly at `58fc6a9eef14a052578b7fdf66478b7f4f30f316`, which already contains canonical Cookie session revocation #173, bounded ordinary Outbox #159 and bounded alert queue #161. It includes the complete previous #143→#155→#166 worker chain and independent locked-handler-start QA #167, without merging any unsafe intermediate worker version into main. A fresh exact-HEAD full F1 CI is required on this combined base. Earlier green standalone worker runs are supporting evidence, not proof of this final integration. The worker still has at-least-once external-effect semantics; providers must dedupe by the stable event key. No live channels, PII, payments or production rollout.
