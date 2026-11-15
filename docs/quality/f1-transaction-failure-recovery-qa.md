# Cookie F1 independent QA — late transaction failures and recovery

**Scope:** [Issue #21](https://github.com/tim8es/cookie/issues/21); no runtime/backend/frontend implementations changed. Only a **new** synthetic PostgreSQL integration test and this QA document are authored. No credentials, real customer data, external channels, or production deployments.

## Tested failure boundaries

Test `apps/api/test/booking-transaction-recovery-qa.integration.test.ts` creates a completely synthetic, future-dated salon with a single staff member, service, location, customer and owner-scoped permission.

It installs one **temporary, tenant- and operation-scoped PostgreSQL BEFORE INSERT trigger** at a time. The trigger deliberately throws SQLSTATE `P0001` for the test tenant only. The trigger/function are removed immediately after each injected failure and again via the outer cleanup guard. The integration test suite already runs with `--test-concurrency=1`, so synthetic fault DDL does not overlap another CI test.

| Command | Failure point | Invariant after rollback |
| --- | --- | --- |
| `CreateBooking` | Before `booking.confirmed` Outbox insert, after Booking insert | No Booking, Outbox, command receipt, or committed authorization preflight |
| `CreateBooking` | Before `booking.create` receipt insert, after Booking and Outbox insert | No Booking, Outbox, receipt, or committed authorization preflight |
| `CancelBooking` | Before `booking.cancelled` Outbox insert, after status update and mutation audit | Existing Booking remains Confirmed; no cancellation audit/event/receipt |
| `CancelBooking` | Before `booking.cancel` receipt insert, after status update, audit and Outbox | Same: original Booking remains Confirmed; no cancellation audit/event/receipt |

In each case the **original idempotency key is retried after removing the failure trigger**. The retry must complete successfully and may not be confused with a committed previous attempt. Subsequent successful same-key replays must return the original receipt without re-executing the entitlement/cancellation policy callback or creating duplicate Booking/Outbox entries. Authorization preflights on committed retries are legitimately counted as separate authorization audit events.

The test finally verifies `booking.confirmed` and `booking.cancelled` events refer to the correct Booking UUID.

## Boundaries

The triggers affect only randomly generated synthetic tenant data; functions and triggers are never migrations and are not available in the running application. This is **fault injection in a CI PostgreSQL 16 database**, not an operational capability or a production test. A failure inside a transaction is not the same as an ambiguous network drop **after COMMIT**, where callers may not know whether the transaction committed. That separate unknown-commit/idempotency scenario requires an additional integration test with a network fault proxy, or carefully isolated client-disconnect simulation.

This QA step does not establish real authentication, real entitlement policies, public API, provider delivery guarantees, performance SLO, encrypted operational backups or any pilot readiness. Backend and frontend agents retain complete ownership of their implementation files; defects discovered by QA should be documented instead of silently changing their code.
