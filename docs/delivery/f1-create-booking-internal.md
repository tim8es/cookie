# F1 — CreateBooking guarded internal transaction (partial #21)

**State:** engineering vertical slice on synthetic data; not an API, customer
booking product, or pilot authorization. Design references:
`ADR-0003`, `docs/architecture/data-and-booking.md`, #18/#19/#20/#21.

## Implemented

- Migration `0006_booking_idempotency.sql` stores a successful command
  receipt by tenant, verified actor identity, operation and SHA-256 key digest.
  It stores a hash of the normalized request and the exact committed response.
  The raw idempotency key and any customer contact/PII are **not persisted**.
- `createBookingInternal` is a server-internal command, **not mounted by
  `apps/api`**. It accepts a `TrustedActor` produced by an external verified
  session pipeline (not implemented here) and calls the existing persisted
  tenant/location-aware `booking.create` policy guard within the transaction.
  Client/self-service identities have no working relationship proof and are
  therefore not enabled by this code.
- A transaction-scoped advisory lock serializes repeats of one key; different
  keys for one master serialize on the tenant-owned StaffProfile row. Verified
  service assignment, staff publication, branch timezone, Customer FK,
  server-side price, shift, breaks, exceptions, tenant-wide occupied slots and
  a mandatory entitlement callback are checked before inserting Confirmed.
  For this F1 technical slice, slot grid is one-minute anchored at shift start;
  no fixed client booking grid or timezone recurrence policy is finalized.
- The Booking row, immutable-by-convention command receipt and privacy-safe
  outbox event are written in the **same PostgreSQL transaction**. No event or
  receipt persists if any step fails. Replay after a committed response returns
  the stored original result, even if the service price has changed; a reused
  key for another request is rejected. The PostgreSQL range exclusion from
  migration 0005 is the final concurrent overlap backstop.
- No notifications are sent inline; the separate worker owns delivery.

## Important gates NOT yet satisfied

1. **No live session verifier, public API, client guest proof or Customer
   identity relationship.** Callers cannot supply `TrustedActor` from raw
   client JSON. Membership/role policy revocation and concurrent publication
   changes require an explicit transaction/locking design before production.
2. **No real entitlement source.** The mandatory `assertEntitled` port has
   deliberately no default. Synthetic integration tests supply a stub, not
   a commercial approval. All production callers must use trusted server
   persisted trial/paid entitlements checked within the transaction.
3. **No full Catalog quote and promotion resolver.** Current F1 uses the
   server-side Service base price snapshot, not F2 staff/location overrides,
   owner discount order, promo redemptions, legal pricing or taxes.
4. **No authenticated ScheduleChange.** The intended staff lock protocol
   must also be used by schedule edits and assignment/publication operations;
   concurrent phantom shift/block inserts are not yet fully prevented.
5. No complete Create/Cancel/Reschedule domain API, mutation audit beyond
   authorization preflight, RLS/least-privilege DB roles, operational retries
   and notification provider delivery guarantees. A direct SQL writer with
   broad DB privileges is not protected by the application permission guard.

**Coverage:** synthetic PostgreSQL tests verify concurrently repeated keys,
original response after a changed price, different-key branch conflicts,
post-buffer and break checks, forbidden identity, denied entitlement rollback,
and exactly one committed Booking + receipt + outbox per successful command.
The test does **not** establish production safety or authorize a real pilot.
