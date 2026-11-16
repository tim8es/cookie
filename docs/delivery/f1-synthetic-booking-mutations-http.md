# F1 synthetic business-side Booking mutations via HTTP

**PROPOSED / test-only / no production routes.** This changes only the
independent Fastify transport boundary, not the already-merged domain
CancelBooking/RescheduleBooking logic or migration history.

## Opt-in composition

`createApp(pool, { syntheticBookingMutations: { pool, verifier, assertMayCancel,
assertMayReschedule } })` enables these two endpoints **only when a caller
explicitly injects all dependencies**. Normal `apps/api/src/main.ts` injects
none and returns 404. Synthetic `Fastify.inject` CI is the only supported
current consumer. The verifier must establish a server-trusted tenant/identity;
no JSON/header values or path tenantId can change that identity. A synthetic
bearer token fixture is **not** a deployed credential/verifier.

Both server-side policy callbacks run **inside** the existing booking
transaction, subject to live checks of membership, role, location, staff,
status, time, idempotency, audit, Outbox and PG exclusion. The callbacks are
required: there is deliberately **no default allow** for overdue bookings.
These are explicitly business-side endpoints and cannot authenticate a client
by merely knowing a customerId, phone number or bookingId.

## Route contract (OpenAPI: packages/contracts/openapi/f1-synthetic-v1.yaml)

- `POST /v1/organizations/:tenantId/bookings/:bookingId/cancel` with
  `Authorization: Bearer <verified synthetic credential>` and
  `Idempotency-Key`, empty or omitted JSON body: HTTP 200
  `{bookingId,status:"CancelledByBusiness",cancelledAt}`. Only actual
  `booking.cancel` permission on the persisted booking is accepted.
- `POST /v1/organizations/:tenantId/bookings/:bookingId/reschedule` with
  same headers, body strictly `{ "newStartAt": "2027-04-12T14:00:00Z" }`:
  HTTP 200 `{bookingId,status:"Confirmed",previousStartAt,startAt,endAt,
  occupiedUntil,priceKopecks}`. Actual permission `booking.reschedule` and
  trusted business policy are mandatory. The booking identity, service, staff,
  branch and original price/duration/buffer snapshots remain unchanged.

HTTP mapping: `400 INVALID_REQUEST`, `401 UNAUTHENTICATED`,
`403 ACCESS_DENIED|CANCELLATION_POLICY_DENIED|RESCHEDULE_POLICY_DENIED`,
`404 BOOKING_NOT_FOUND`,
`409 BOOKING_NOT_CONFIRMED|BOOKING_CONFLICT|IDEMPOTENCY_KEY_REUSED`,
`503 BACKEND_UNAVAILABLE` (no SQL detail leakage).
A matching-key replay returns exact original receipt only after a current
permission check; a changed payload/key reuse is rejected. Unknown network
outcome after a successful COMMIT must be retried with **same actor, tenant,
key and input**. Do not treat 503/timeout as permission to create a new key or
to show optimistic success. After failed reschedule, old booking is still
Confirmed at its old start. After committed cancellation, its staff slot is
available for another transaction.

## Safety and quality gates

The same synthetic PostgreSQL HTTP test verifies policy-denied rollback,
scoped role denial, invalid payload rejection, successful move/cancel, exact
idempotent replay, status/price preservation, old-slot safety, rebooking after
cancel and exactly one mutation audit+Outbox+receipt each. The existing
`createBookingInternal`, `cancelBookingInternal` and
`rescheduleBookingInternal` remain the business implementation.

**NOT implemented:** verified production AuthN, Identity↔Customer linking,
real deadline/exception policy or entitlements, customer self-service,
production network error reconciliation, RLS or comprehensive simultaneous
schedule mutation guarantees, promo restoration and F2 pricing; all are
separate review gates. No real PII, paid providers or deployments permitted.
