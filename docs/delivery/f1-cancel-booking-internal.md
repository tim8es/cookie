# F1 — internal business-side CancelBooking (Issue #21, partial)

**Status:** internal F1 engineering on synthetic PostgreSQL fixtures. No API, no
customer self-service, no live identities, notifications, payments or pilot.
Preserves the already merged `createBookingInternal` and migration history.

## Implemented technical contract

- `cancelBookingInternal(pool, input, assertMayCancel)` requires a **server-verified**
  `TrustedActor`, a tenant-scoped Booking ID, an actor-scoped idempotency key
  and a **mandatory trusted cancellation-policy port**. No default policy
  implementation is supplied. In particular, the actual salon cutoff
  rules/exception approval are not silently chosen by this module.
- This initial command cancels **only on behalf of a business** using
  `booking.cancel` permission on the authoritative tenant/location/staff
  relation loaded from PostgreSQL. It emits `CancelledByBusiness` only.
  Client cancellation (`CancelledByClient`) is intentionally disabled until a
  Customer ↔ Identity ownership proof and verified guest flow exist.
- The command locks the StaffProfile row before the Booking row. It follows
  the same ordering as `CreateBooking` so a cancellation and subsequent
  booking on this staff cannot silently bypass staff synchronization. The
  PostgreSQL exclusion constraint remains the final no-overlap defense.
- A single transaction contains: reauthorization, transaction-scoped
  tenant/actor/operation/key advisory lock, confirmed-state validation,
  cancellation-policy check, `Confirmed → CancelledByBusiness` with
  server timestamp, minimal mutation audit (actor/booking/correlation), a
  `booking.cancelled` Outbox event and an immutable command receipt. On a
  rollback, the booking remains Confirmed and the cancel event/receipt do not
  appear. No provider is called in the transaction.
- A successful same-key retry returns the original response including
  `cancelledAt`, without a second event, receipt or policy evaluation.
  Reusing a key for a different booking is denied. Attempting to cancel a
  non-Confirmed booking with a new key is denied, not treated as a new
  successful cancellation.
- No Customer/identity data, contact text, cancellation reason, raw key or
  message payload is persisted in the audit or Outbox. Existing confirmed
  Booking price and duration snapshots are not edited.

## Validation and intentionally open gates

The synthetic integration test covers policy refusal with intact Confirmed,
unauthorized/foreign actor, concurrent same-key cancellation, replay with
unchanged timestamp, reused-key refusal, one audit/Outbox event, cancellation
of an already cancelled booking, and successful new CreateBooking on the
released staff slot. PostgreSQL migrations and backup/restore smoke must
pass in CI.

**Not implemented:** a real `assertMayCancel` deadline/exception policy,
customer self-service relationship, cancel reason and advance notice UX,
promotion redemption return (DEC-068; no promotion ledger yet), payment
refunds, cancellation after visit/no-show policy, real session verifier,
authorization mutation audit for denied attempts, customer notifications
or public API. Any staff/role publication changes must use protected
transactions before production. No real PII, production or commercial pilot.
**Issue #21 remains open.**
