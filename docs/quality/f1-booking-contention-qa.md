# F1 QA: cross-branch, cross-tenant booking contention regression

**Scope:** independent quality evidence for [Issue #21](https://github.com/tim8es/cookie/issues/21). This slice changes **only a new PostgreSQL integration test and this document**. It does not edit backend/domain implementations, frontend components, migrations, or shared CI configuration. No real customer data or delivery providers.

## Scenario

The regression `apps/api/test/booking-contention-qa.integration.test.ts` creates two synthetic organizations with distinct owners and customers but deliberately identical StaffProfile and Service UUIDs. Each organization has two locations (A and B), both assigning the same staff member with compatible shifts. Staff occupancy must be **organization-wide across locations**, but **isolated between organizations**.

In one burst the test submits **24 simultaneously started** `createBookingInternal` calls: 12 for each organization, alternating locations, with **different idempotency keys** and the same UTC start time. Only one call per organization may commit `Confirmed`; losing requests must return `BOOKING_NOT_AVAILABLE` or `BOOKING_CONFLICT`, not silently create Pending/overlap. Each organization must retain exactly one Booking, one successful create receipt and one `booking.confirmed` Outbox event, and event `bookingId` must refer to its committed Booking.

Then each winner is retried through **12 concurrent same-key calls**. Every retry must return the identical original receipt, without reexecuting the entitlement callback, creating another Booking/receipt, or adding an Outbox event. Reusing the winning key with a changed location must fail with `IDEMPOTENCY_KEY_REUSED`.

Finally, a tenant-A command with a tenant-B Customer UUID for an otherwise available time must fail closed with `BOOKING_NOT_AVAILABLE`.

## Acceptance and limitations

The test is automatically included by the existing `pnpm test:integration` glob. Its synthetic fixtures use random UUIDs, a future UTC date, local PostgreSQL 16, and have explicit cleanup. It does not mock the real Booking transaction or weaken permissions. No production source/API changes are required.

This is an **adversarial deterministic CI smoke** for a 24-command contention burst, not a statistically valid throughput/latency benchmark. CI result and exact head SHA must be captured before merging. It does not prove sustained performance, network-level multi-process behavior, provider exactly-once semantics, real authenticated client access, or live production readiness. Further production work remains in #18–#22, including authorization, legal/PII, operational SLOs, and actual pilot gates.

Coordination rule: this QA PR owns only the two new files above. Backend and frontend agents retain ownership of their own implementation branches and files; any failure discovered by this test should be reported to the affected owner instead of silently modifying their code.
