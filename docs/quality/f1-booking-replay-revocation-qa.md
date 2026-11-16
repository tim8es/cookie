# Independent QA — booking receipt replay versus current authorization

**Issues:** [#21 Booking engine](https://github.com/tim8es/cookie/issues/21), [#18 Identity/Policy](https://github.com/tim8es/cookie/issues/18), [#19 persistence](https://github.com/tim8es/cookie/issues/19). Test-only F1 change against real PostgreSQL 16. No API, domain, SQL migration, or production changes.

## Threat model

An internal `CreateBooking`, `RescheduleBooking` or `CancelBooking` completes and stores a durable idempotency receipt. Later, the same trusted identity loses organization membership or its role/assignment is disabled. If a repeat request returned its old receipt **before checking current permissions**, it could disclose a booking ID, price, timestamps or status to a now-unauthorized actor. Idempotency is not a substitute for AuthZ.

The new integration test `apps/api/test/booking-replay-revocation-qa.integration.test.ts` exercises all three real domain commands (no mocks of the database or policy store), using synthetic actors, role assignments, a staff/service/customer and a future UTC shift.

| Command | Persisted business state | Revocation before same-key replay | Re-enabled grant |
| --- | --- | --- | --- |
| CreateBooking | Confirmed booking, receipt, Outbox | Inactive membership: `ACCESS_DENIED` even for same key and altered payload | Exact stored receipt; callback not rerun |
| RescheduleBooking | Same booking ID with new start, audit, receipt and Outbox | Inactive role: `ACCESS_DENIED` | Exact receipt; changed payload under original key rejected |
| CancelBooking | CancelledByBusiness, cancellation audit, receipt and Outbox | Inactive role assignment: `ACCESS_DENIED` | Original cancellation receipt; no second cancellation |

The test snapshots Booking status, actual start, price, durable command receipts, Outbox and business mutation audits before and after revocation and authorized replay. It explicitly verifies that historical CreateBooking receipt replay does **not** reactivate a Booking already cancelled.

## Security and architectural boundaries

- Current **server-owned** `TrustedActor` is a test fixture; real token verification, identity↔customer binding and publicly callable Booking HTTP routes are still absent.
- No commercial tenant data, real PII, live notification providers, payments or production environment.
- Revoked command attempts are rejected in their SQL transaction. Because authorization preflight audit writes are in that same transaction and the command rolls back on denial, **this test does not establish a durable denied-attempt audit trail**. Whether to persist a separate security-denial trail requires review in #18, not a silent transaction-semantics change.
- No claim of synchronous revocation mid-flight *within a concurrent transaction*; the test proves the next command checks the latest committed permissions.
- Existing `apps/api/test/*.integration.test.ts` PostgreSQL 16 CI glob picks up the new test automatically. No workflow edits in the final PR; draft only until owner review.
