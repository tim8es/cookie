# F1 independent QA — unknown COMMIT acknowledgment and idempotent recovery

**Scope:** [Issue #21](https://github.com/tim8es/cookie/issues/21) and [Issue #19](https://github.com/tim8es/cookie/issues/19). This test changes **no backend/frontend sources, schemas, migrations, package manifests or CI workflows**. Synthetic PostgreSQL data only. The dedicated test is automatically executed by the existing `apps/api/test/*.integration.test.ts` suite.

## Failure scenario

PostgreSQL can successfully commit a mutation and the connection can fail before the caller receives its acknowledgement. The application sees `ECONNRESET`, but does **not** know whether the command committed. Blindly sending a fresh idempotency key could duplicate business work.

`booking-unknown-commit-qa.integration.test.ts` uses an **explicit deterministic driver-boundary simulation**: for one command it performs the real PostgreSQL `COMMIT` first, destroys that physical pooled connection, and then raises a synthetic `ECONNRESET` instead of returning the successful acknowledgement. Any attempted `ROLLBACK` on the disconnected test facade also fails. The next request uses a **new healthy connection** to the same PostgreSQL 16 instance.

This tests the "commit succeeded but response was lost" branch and intentionally does **not** claim to perform real TCP packet corruption or network-proxy disconnection. Production networking and retry timeouts require separate tests.

## Acceptance criteria

The simulation applies individually to all three internal operations:

| Operation | Durable database result after the reported connection failure | Required same-key retry |
| --- | --- | --- |
| `CreateBooking` | One Confirmed Booking, one receipt, one `booking.confirmed` event | Returns the original committed receipt; entitlement callback not re-run |
| `RescheduleBooking` | One preserved Booking ID with changed start time, original price, one movement audit/receipt/event | Returns original time-change receipt; policy not re-run |
| `CancelBooking` | Existing Booking becomes CancelledByBusiness; one cancellation audit/receipt/event | Returns original cancellation receipt; policy not re-run |

An altered request using the same key must be rejected; a new cancellation key after the Booking was cancelled must not create another cancellation. No mutation, audit, receipt or Outbox event may be duplicated on same-key retries. All Outbox payloads must refer to the same real Booking UUID. The test does not fabricate a successful response for the original disconnected call; the result is retrieved via the persisted receipt on replay.

## Guardrails and remaining risks

The driver interception is **test-only**, created in a single new test file and not installed into production. The real DB is PostgreSQL 16 in CI. No actual payment provider, user identities, real customer data, network traffic modification, or live notifications.

This is one deterministic test of the **successful-COMMIT + lost-ACK** branch. The separate [late SQL failure QA](f1-transaction-failure-recovery-qa.md) covers rollback before COMMIT. Additional pre-release gates: real socket drop before/while COMMIT (commit outcome uncertain), HTTP adapter retry behavior, actual AuthN, policy/entitlement sources, client idempotency-key generation, timeouts, externally visible acknowledgment, provider dedupe and operational monitoring. **Do not infer production "exactly once" delivery guarantees from this test.**

Coordination: backend and frontend agents own implementation; the QA PR must consist only of this new test and this document. Any discovered runtime defect must be raised for the appropriate owner rather than editing their files.
