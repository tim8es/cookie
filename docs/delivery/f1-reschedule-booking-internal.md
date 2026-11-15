# F1 — internal time-only RescheduleBooking (Issue #21, partial)

**Status:** internal synthetic-only engineering. Built above merged PR #59
business cancellation, preserving its command, test cases and SQL migration
0008. No public/customer/guest API, real commercial pilot, or personal data.

## Accepted product invariants implemented

- **DEC-070:** rescheduling an already Confirmed booking changes ONLY the time
  interval. It preserves `bookingId`, `tenantId`, `customerId`,
  `staffId`, `locationId`, `serviceId` and the original duration,
  post-service buffer and price snapshots; any linked promotions remain
  untouched. It never creates or restores a promo redemption.
- **DEC-072:** changing Service/Staff/Location is not supported by Reschedule;
  such changes require separate CancelBooking + CreateBooking, with their
  own policies and idempotency keys and without promising an atomic swap.
- `0009_booking_reschedule.sql` extends the existing tenant/actor/operation
  scoped `command_receipts` to `booking.reschedule` and adds a separate
  append-only `time_change_audit` with original/new UTC instants, actor,
  booking and correlation (no PII, promo/code tokens, freeform text or raw
  idempotency key).
- `packages/domain-booking/src/reschedule.ts` is **internal only**. It
  requires server-verified `TrustedActor`, an existing tenant booking,
  `booking.reschedule` permission scoped to its actual Location, and a
  mandatory trusted `AssertBookingMayReschedule` callback implementing
  accepted deadlines, exceptions and entitlement policy. There is no
  default allow/cutoff; policy adapter failures deny and roll back.
- Staff row is locked before Booking row, matching existing business
  `cancelBookingInternal`; same-key retries are serialized with a
  transaction advisory lock. Before updating Confirmed, the command
  checks configured IANA zone, active Staff/Service/Location assignment,
  current shift and break/exception data, and Confirmed occupancy across
  **all branches**, excluding the booking's previous occupied range.
  Availability is rechecked with **the booking's existing duration/buffer**.
  PostgreSQL GiST exclusion remains the final conflict guard.
- Confirmed time update, audit, privacy-safe `booking.rescheduled` outbox
  event and exact successful receipt share one PostgreSQL transaction.
  Failures preserve the old Confirmed slot; same-key retries return
  exactly the originally committed response, even if the booking/catalog
  later changes. No inline provider call or side effects are permitted.

## Synthetic verification

Extended the existing combined Create+Cancel PostgreSQL fixture with denied
deadline, unauthorized actor, cancelled booking, break overlap, confirmed
booking overlap, unchanged original state on failure, **concurrent same-key
retries**, preserved price even after catalog price change, preserved original
duration despite new catalog duration, exactly one audit/outbox/receipt, and
service/staff/location identity invariants. Migration/restore smoke now checks
nine immutable numbered migrations and `time_change_audit`.

## Remaining production gates

- Verified session and customer ownership/guest flow; no self-service endpoints
  or human-facing cancellation/transfer UI yet.
- Real location/service-specific rescheduling deadlines and exception rules;
  no ad hoc default permission/cutoff is guessed.
- Staff schedule mutation/protected publication participating in the same
  locking protocol; this code alone does not prevent unguarded schedule edits.
- Commercial entitlements, full F2 promotion ledger, payment/prepayment
  policies, RLS/least-privilege DB roles, safe revocation under concurrency,
  delivery adapter and external notifications.
- Real data, production deployment and commercial pilot remain **unauthorized**.

The existing merged PR #59 CancelBooking is unchanged; its missing promotion
restoration adapter (DEC-068) is still a release gate, not solved here.
