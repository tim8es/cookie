# F1 Booking persistence + exclusion constraint spike

**Status:** engineering partial implementation, not a Booking API or release.
**Issues:** #18, #19, #20, #21, #22 · **ADR:** ADR-0003.
**Evidence:** `db/migrations/0005_booking_exclusion.sql` and
`apps/api/test/booking-exclusion.integration.test.ts`.

## What is implemented

- `cookie_customers.customers`: tenant-scoped synthetic Customer FK anchor
  without contact details or verified ownership. It is **not** authentication.
- `cookie_booking.bookings`: exactly one Service, StaffProfile and Location
  per Booking, with tenant-composite FKs to assigned staff/services and Customer.
- Client-visible `[start_at, end_at)` and staff `[start_at, occupied_until)`
  use the single Service duration and post-service buffer snapshots. Numeric
  kopeck price snapshots allow `0` and prohibit negative values.
- Explicit Confirmed, CancelledByClient, CancelledByBusiness, Completed and
  NoShow values; cancellation timestamp required when status is cancelled.
- `btree_gist` exclusion on **(tenant_id, staff_id, occupied range)** for
  Confirmed status. **Location is not part of the conflict key.** The half-open
  range permits adjacent bookings; concurrent conflicting inserts are
  rejected by PostgreSQL SQLSTATE `23P01`.
- Failed attempts cannot change or consume a previously committed Confirmed
  booking. A successful explicit status transition to cancellation releases
  that occupied interval at the DB constraint level.

## Deliberate non-scope / blockers

These tables must not be exposed directly to clients. A valid SQL insert does
**not** prove that a booking request is authorized, correctly priced, within
working hours, permitted by entitlements or idempotent. There is no API or
domain command that can safely create, reschedule or cancel real bookings yet.

Before marking #21 or pilot ready, implement and test, at minimum:

1. Trusted actor/guest authentication and tenant/location/customer
   authorization, revalidated at mutation time under transaction;
   unprivileged database access and RLS/role boundaries.
2. `CreateBooking` transaction: stable tenant+staff row lock shared with
   `ScheduleChange`, current Service assignment, server price, active
   entitlement, location schedule, breaks, exceptions and cross-location
   occupancy recheck; hold no slots on read-side availability.
3. Tenant-scoped idempotency receipts with request hash and durable response;
   same key + different payload must fail, and crash-after-commit retry must
   not create a second booking.
4. `CancelBooking` and time-only `RescheduleBooking` with deadlines,
   authorization, immutable Service/Staff/Location and price/promo snapshots,
   conflict rollback and mutation audit.
5. Transactional outbox event and committed booking inside the same DB
   transaction; worker delivery errors must never roll back a Confirmed.
6. Explicit schedule-change consistency (including edits on assigned staff
   and conflicting already-Confirmed bookings), exact status transition
   policy, customer identity linking and no-PDN development restrictions.
7. Real PostgreSQL concurrency, permission, idempotency, schedule-race and
   crash-after-commit suites beyond this foundational exclusion test.

No production deployment, real personal data, payment execution or external
channel integrations are authorized by this spike. Existing schemas remain
mutable only via new migrations; do not rewrite historical migration files.
