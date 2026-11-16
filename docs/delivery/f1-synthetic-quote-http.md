# F1 synthetic provisional Quote: authoritative catalog base price

**Status:** PROPOSED / opt-in synthetic-only, stacked after Booking HTTP and
business mutations. This is **not** F2 financial pricing or a published API.

## Flow and wire contract

1. Authenticated synthetic owner/scoped administrator queries
   `GET /v1/organizations/:tenantId/locations/:locationId/catalog` to choose
   an active Service / Staff assignment. The base price is read from the DB.
2. Query `GET /v1/organizations/:tenantId/locations/:locationId/availability?serviceId=&staffId=&date=YYYY-MM-DD`.
   `date` is the **Location's IANA local date**, `startAt/endAt/occupiedUntil`
   are absolute UTC. This read does NOT reserve anything.
3. For a chosen UTC-minute `startAt`, query
   `GET /v1/organizations/:tenantId/locations/:locationId/quote?serviceId=&staffId=&date=&startAt=`.
   Response contains `locationId`, `serviceId`, `staffId`, UTC intervals,
   duration, post-buffer, time zone, `priceKopecks` decimal string,
   `currency:"RUB"`, `priceKind:"base-service"`, `provisional:true`.
   A 409/BOOKING_CONFLICT means the exact slot is no longer available:
   refresh availability, not silently substitute a time.
4. On click, send only `{customerId,locationId,staffId,serviceId,startAt}`
   and `Idempotency-Key` to the verified *staff-assisted* CreateBooking API.
   No price/quote/tenant/confirmation fields are accepted. Within its **own**
   transaction, CreateBooking rereads active assignment, schedule, occupancy
   and current server price and commits the immutable receipt and Outbox.

`readBookingAvailability` in
`packages/platform-db/src/booking-availability.ts` is the shared,
transaction-scoped read port used by **both** availability and Quote.
It delegates time-window calculations to the existing Scheduling domain.
No business slot algorithm or separate Booking write exists in the HTTP layer.
A synthetic Quote is not a durable hold, signed quote, guarantee or request
commit. Price changes between provisional read and CreateBooking do not yield
PRICE_CHANGED/reconfirm: a successful Create uses the *current* server price
and the actual amount from Confirmed receipt, per DEC-055.

**Out of scope / blockers:** location- and staff-specific price override,
discount compatibility/promo consumption, final whole-ruble half-even rounded
amounts and breakdown (F2), real authorization/entitlement/customer binding,
legal disclosure for modified prices, public/guest access, actual rate limiting,
network error delivery. Those are not silently implemented by base-service
pricing. `main.ts` does not enable the synthetic API.
