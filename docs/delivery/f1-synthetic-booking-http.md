# F1 Synthetic Booking HTTP vertical slice (PR, review required)

**Status: PROPOSED implementation, NOT production, no customer self-service.**
Refs: #18, #19, #20, #21, #22, #23, #66; ADR-0003/0004 and DEC-043/055.
Wire contract: `packages/contracts/openapi/f1-synthetic-v1.yaml`.

## API v1: only opt-in test-harness composition

Production `apps/api/src/main.ts` intentionally passes **no**
`syntheticBookingRoutes` to `createApp`: all Booking routes are 404.
A strictly isolated synthetic integration harness may call:

```ts
const app = createApp(pool, {
  syntheticBookingRoutes: {
    pool,
    verifier: trustedTestBearerSessionVerifier,
    assertEntitled: syntheticOnlyInTransactionEntitlementAssertion,
  },
});
```

The verifier is a **server-owned trust port** and MUST validate an issued
credential, session/tenant binding, expiry and revocation before returning
`VerifiedSession`. The repository supplies **no live AuthN implementation**.
Do not use hardcoded bearer tokens, request header identity IDs, customer IDs or
tenant IDs as proof. The sample above is a type-level illustration, not a
production setup recipe. No test endpoint is enabled by environment variable,
no public listener is started. CI also starts a short-lived listener on
`127.0.0.1:0` (an ephemeral local-only port) using that **same isolated test
app**. Its synthetic bearer values have no credential meaning outside that
controlled test process and MUST never be accepted by a deployed service.

The mandatory `assertEntitled` callback is executed by the internal
`createBookingInternal` within its PostgreSQL transaction, for new creates.
It has no production default; CI supplies a synthetic-only no-op to validate
transaction behavior. The HTTP create command is **staff-assisted only**:
verified owner/admin with `booking.create` for the persisted staff/location.
`customerId` is a pre-created synthetic tenant Customer FK, **not a proof of
client ownership**. Do not activate public customer/guest booking until the
Identity↔Customer verifier, entitlement source, and production auth guards
are approved/tested.

## Surface: no duplicate domain logic

| HTTP | Response | Guard |
| --- | --- | --- |
| `GET /v1/organizations/:tenantId/locations/:locationId/catalog` | `{offers:[{serviceId,serviceName,staffId,staffName,durationMinutes,postServiceBufferMinutes,priceKopecks,timeZone}]}` | `booking.create` for location |
| `GET /v1/organizations/:tenantId/locations/:locationId/availability?serviceId=&staffId=&date=YYYY-MM-DD` | `{priceKopecks,slots:[{startAt,endAt,occupiedUntil}]}` | `booking.create` for staff+location |
| `POST /v1/organizations/:tenantId/bookings` | HTTP 201 `{bookingId,status:"Confirmed",startAt,endAt,occupiedUntil,priceKopecks}` | internal `createBookingInternal` with live DB permission |
| `GET /v1/organizations/:tenantId/bookings/:bookingId` | persisted booking snapshot | `booking.read` scoped to actual location/staff |
| `GET /v1/organizations/:tenantId/locations/:locationId/calendar?from=&to=` | `{bookings:[...]}` | `booking.read` for location, UTC half-open 7-day max, 200-row bound |

All routes accept `Authorization: Bearer <verified session token>` *only in
the injected test harness*. Path tenant MUST equal the tenant bound by verifier.
No tenant, actor, correlation, trust, quote, price or status from JSON is used
as authoritative context. Errors have `{ "error": { "code": "..." } }`.
GET is read-side only; availability may become stale at any instant.
The availability response also includes `priceKopecks: string | null`
representing the **current server-side Service base price** at the time of
reading active staff/service settings. If the assignment is absent/inactive,
`slots=[]` and `priceKopecks=null`. No caller price is accepted. This is NOT
a committed Quote: F2 staff/location overrides or promotions are not supported,
and a price update between availability and CreateBooking means the latter may
commit a different server-side current base price. The frontend MUST display
the actual returned CreateBooking receipt price in its final confirmation.

Create requires header `Idempotency-Key` (1–128 ASCII-compatible key chars
as currently enforced by internal command) and JSON **exactly**:

```json
{
  "customerId": "<synthetic-customer-uuid>",
  "locationId": "<location-uuid>",
  "staffId": "<staff-uuid>",
  "serviceId": "<service-uuid>",
  "startAt": "2027-04-12T10:00:00Z"
}
```

`startAt` must be a full UTC minute and is rechecked inside the DB
transaction. `endAt` is the client-visible service end; `occupiedUntil`
includes staff buffer. Times in response are canonical UTC with milliseconds.
`priceKopecks` is a **decimal string of base Service price** read from
PostgreSQL at create time and saved in Booking: no client price/discount. F2
price resolver, staff/location overrides, promotions and final whole-ruble
rounding are not implemented; do **not** label this F1 base-price field an
F2 Quote or claim promotions are complete.

## Frontend error and retry rules

- `401 UNAUTHENTICATED`: stop and re-authenticate, **no** optimistic success.
- `403 ACCESS_DENIED`: revoked member/role/location or wrong tenant. Do not
  attempt another tenant or retry without a new authorized session.
- `400 INVALID_REQUEST` / `INVALID_BOOKING_COMMAND`: fix payload; do not
  automatically retry.
- `409 BOOKING_CONFLICT`: chosen slot is stale, occupied or otherwise no
  longer available. Refresh availability and ask user to choose again. No
  `Pending` reservation and no automatic second slot.
- `409 IDEMPOTENCY_KEY_REUSED`: request key was already committed with a
  **different** payload. Generate a new key only for an actual new operation,
  never as automatic recovery from a lost response.
- `503 BACKEND_UNAVAILABLE`, timeout, connection reset, lost response:
  outcome is **unknown**. Retry original byte-equivalent normalized payload
  with the **same** idempotency key and authenticated tenant/actor, to obtain
  the durable original 201 receipt. Never assume a server error means a
  booking did not commit. A matching replay still rechecks current rights;
  after revocation it returns 403. Retrying with a different actor is a new
  idempotency scope and must not be attempted automatically.
- `404 BOOKING_NOT_FOUND`: no record in current verified tenant; do not
  reveal cross-tenant existence.
- Business/session errors are not wire-visible SQL/driver exceptions.

`GET /calendar` is a bounded first slice only (<=200 rows), not a
paginated search contract. To support day/week UI, frontend explicitly
converts the target Location IANA local day to UTC `from`/`to` and uses a
half-open range. Real calendar pagination and staff-only visibility require
a separate contract review before public release.

## Evidence and unresolved gates

The synthetic HTTP integration test must prove catalog→availability→create
(Confirmed + bookingId)→admin read/calendar, concurrent duplicate slot
conflict, same-key retry after lost client response simulation, reuse with
changed payload, cross-branch staff overlap, scoped admin denial, outsider
denial, revocation, and one Booking+receipt+Outbox. The integration test now exercises actual
loopback HTTP over a transient local TCP listener: catalog, availability,
concurrent CreateBooking requests, idempotent replay, read and calendar;
a successful replay response body is deliberately discarded before retrying
with the same key. This validates a client not retaining its reply, **not**
a forced TCP reset or a lost PostgreSQL COMMIT acknowledgement. Existing
internal domain test suites remain the authoritative atomic rollback/mutation
proof. Forced TCP post-COMMIT loss, real AuthN, load and production concurrency
remain unverified.

Not yet exposed: protected CancelBooking/RescheduleBooking HTTP adapters,
customer linking, real entitlements, schedule publishing guards,
no-overlap under all concurrent scheduling mutations, price/discount resolver,
full administrative pagination, real notification provider, RLS/least-privilege
DB access. This is **not** a customer-facing pilot or production release.
