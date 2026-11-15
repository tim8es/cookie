# F1 Booking mutations: CancelBusiness and time-only Reschedule (partial #21)

**Status:** internal technical implementation with synthetic PostgreSQL data;
**not** a public API, client self-service, complete cancellation/promo
implementation or production authorization. References: DEC-045/068/070/072,
ADR-0003, #18/#19/#20/#21/#22.

## Implemented

- Migration `0008_booking_mutations.sql` adds `booking.cancel` and
  `booking.reschedule` to the existing tenant/actor/operation-scoped command
  receipts and introduces `cookie_booking.mutation_audit`. Only successful
  operations commit audits. No raw request keys, promo tokens, contacts, names
  or freeform messages enter the audit/outbox payload.
- `packages/domain-booking/src/mutations.ts` exports two **server-internal**
  functions: `cancelBookingInternal` and `rescheduleBookingInternal`.
  Both load authoritative booking scope from PostgreSQL, require an active
  tenant/location-scoped `booking.edit` policy, serialize exact idempotency
  key retries using transaction advisory locks, then acquire the tenant/staff
  row lock shared with CreateBooking before locking the Booking row.
- Both require an explicit `assertPolicy` callback with the trusted actor and
  actual Booking relations. It must implement deadlines/permissions and any
  commercial restrictions and must **deny by default**; no placeholder policy
  is wired into a real app. The customer identity/guest relationship is not
  implemented, so neither function is mounted as a public route.
- Cancel only an existing Confirmed booking, setting
  `CancelledByBusiness` and `cancelled_at`. A mandatory
  `restorePromotions` callback participates in that same transaction. It
  must restore rights for actually used one-time promos **without extending
  validity** (DEC-068); no live promo ledger/adapter is available yet.
  A failed restore must roll back the cancellation, audit, event and receipt.
- Time-only Reschedule preserves the same Booking ID, tenant, Customer,
  StaffProfile, Service, Location, original price, duration and post-buffer
  snapshots; no promotion is consumed/restored/repriced (DEC-070). It checks
  active assignment, staff/bookable, IANA timezone, current shifts, breaks,
  exceptions and Confirmed occupancy across **all locations** excluding the
  booking being moved. A transaction-level staff lock and PostgreSQL exclusion
  constraint protect double-booking; a failure retains the original Confirmed
  visit/interval. No silent change of staff/service/location is accepted
  (DEC-072); those require two separate Cancel+Create operations.
- Success commits the booking update, minimal mutation audit, outbox event
  and exact receipt in one transaction. Same-key retries return the original
  response without repeating promotion restoration or event delivery.
  Different-key operations on a no-longer-Confirmed booking fail closed.
- Tests extend the existing PostgreSQL fixture to cover policy denial, wrong
  identity, break and conflicting booking, time-only snapshot preservation,
  successful replay and payload mismatch, failed restore rollback, committed
  cancellation, idempotent retry and availability after cancellation.

## Outstanding release gates

1. **No production promo ledger**, refund/restoration adapter or original
   redemption snapshot. The mandatory restore callback is a synthetic no-promo
   assertion in tests, **not** an implementation of DEC-068. Do not expose
   cancellation until atomic redemption restoration is completed.
2. **No live self-service deadline settings or ownership-proof adapter** for
   customer/guest links; cancellation is `CancelledByBusiness` only. Caller
   must supply verified `TrustedActor`, not client JSON or a proxy claim.
3. No staff/location/Service assignment and schedule edit commands sharing
   the same staff lock, no DB least-privilege/RLS, no fully locked membership
   revocation protocol, no production entitlements/payments or promotion
   pricing. Public transport and end-to-end UX remain unimplemented.
4. Transition policy for Completed/NoShow, prepayments/refunds, no-op
   reschedules and metadata-dependent deadlines remains unresolved; this F1
   adapter fails closed rather than choosing commercial defaults.
5. Tests are **synthetic CI evidence only**. Avoid real PII, real customer
   calls, third-party delivery and commercial deployment.

All applied SQL files remain immutable; use the next numbered migration for
future booking/discount policies.
