# F1 independent QA — actor-scoped booking idempotency receipts

**Related:** [Issue #21](https://github.com/tim8es/cookie/issues/21), [Issue #18](https://github.com/tim8es/cookie/issues/18), [Issue #19](https://github.com/tim8es/cookie/issues/19), and the Booking receipt uniqueness migration `db/migrations/0007_booking_idempotency.sql`.

## Gap and risk

The PostgreSQL receipt primary key is `(tenant_id, actor_identity_id, operation, key_sha256)`. It is important that **two different authorized identities in the same Organization may reuse the same raw idempotency key for unrelated commands** without receiving one another's Booking ID, result JSON or receipt.

Existing tests cover same-actor retries and many independent keys across tenants. This test deliberately collides keys **within one tenant across two actors**, while giving both actors valid organization-wide booking permissions. It therefore separates authorization (both are allowed) from receipt ownership (different actor scopes).

## Synthetic integration scenario

`apps/api/test/booking-actor-receipts-qa.integration.test.ts` runs against real PostgreSQL 16 and executes in parallel where supported:

| Operation | Owner | Admin | Expected |
| --- | --- | --- | --- |
| CreateBooking | 10:00 | 14:00 | Two Confirmed bookings, same raw key and key digest, distinct Booking IDs, request hashes, actor-scoped receipts |
| RescheduleBooking | 11:30 | 16:00 | Two distinct move receipts and mutation audits, no overlapping occupancy |
| CancelBooking | Own Booking | Own Booking | Two terminal cancellations, independent receipts and state audits |

All commands use the *same exact idempotency key per operation* across owner/admin actors. For each operation, same-key replay must return the actor's original persisted result without re-running a domain policy or entitlement callback. Changing a request payload but keeping that actor's key must reject with `IDEMPOTENCY_KEY_REUSED`. The test checks individual `actor_identity_id` and `booking_id` associations for all six durable receipts and the six Outbox payloads, plus exact aggregate business state before/after retries.

Finally, both historical CreateBooking and RescheduleBooking receipts are retried after the underlying Bookings have been cancelled: only stored responses may be returned; no Booking must be reactivated or mutated.

## Boundaries and remaining work

- **F1 internal commands only**, synthetic actors and fixtures. Does not implement or verify a publicly available Booking HTTP API, real AuthN, Customer identity binding, paid entitlement, cancellation deadlines, or production payment/notification systems.
- Correct actor scoping of a receipt does **not** imply that every authorized admin is restricted to only Bookings they created. Fine-grained booking read/customer ownership remains a separate authorization review.
- No real PII. This PR changes only the new integration test and this evidence document. Existing CI runs the test automatically through the PostgreSQL integration glob; no workflow changes in the final diff.
- Draft PR, no automatic merge.
