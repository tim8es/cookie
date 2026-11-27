# F1: owner calendar read-only candidate

Stacked on #245, independent of #249 availability preview.
Strict verified session, organization-scoped booking.read, current owner
identity and policy locks before reading branch-local dates. Half-open
civil-day boundaries use the same validated IANA conversion as Scheduling;
invalid/ambiguous midnight fails closed. Query bounds: one or seven
consecutive local days, 2000–2099, maximum 500 overlapping visits; includes
carry-in visits, preserved statuses and immutable price snapshot. Current
catalog/staff names, no customer identifiers or contacts. Existing records
remain readable without staging grant or active service/assignment.
New write routes, holds, customer authentication and public Booking remain
absent. Dedicated application read adapter owns no tables.
The UI offers branch, start date, day/week agenda and previous/next/today,
clears stale data, handles true empty versus error, aborts requests and
clears on expiry. No mock fallback. These are proposed F1 engineering
constraints, not new commercial decisions.

Reuses exact #243 robust transaction wrapper and its seven tests in the
old-stack candidate; reconcile to current-main #247 as appropriate. Source
stack and #242/#201 current-main boundary integration still required.
The PostgreSQL integration and real Chromium smoke create synthetic stored
Booking rows via trusted SQL fixtures ONLY, not a real booking action.
This proves the read path, not booking creation or pilot acceptance.

## F1 follow-up: explicit private-staging owner cancellation (#23, 2026-11-22)

Calendar stays a protected owner read by default. With an additional explicit staging-publication mode and `COOKIE_STAGING_OWNER_CANCEL_CUTOFF_MINUTES` provided by the test operator (no default), the compiled runtime mounts GET `owner-calendar/cancellation/capability` and POST `owner-calendar/{bookingId}/cancel?locationId=...`. The feature is restricted to the *current verified organization owner*, current `booking.cancel` permission, and exact tenant/branch/Booking. A stale preflight is not authority: owner check is repeated inside the existing atomic business cancellation transaction alongside booking permission and staff lock; the explicit temporary cutoff is rechecked in the SQL UPDATE. The existing Booking is not recreated and no new publication grant is required. One acknowledged transaction commits `CancelledByBusiness`, audit, outbox and an actor-scoped idempotency receipt.

Web owner Calendar opens a persisted detail and obtains a dedicated capability before offering a two-step cancellation. It keeps the original key on unknown responses, never calls success on failure, and invalidates/reloads the server calendar only after a confirmed receipt or a known conflict. Tests include missing opt-in, foreign tenant, wrong branch, non-owner and revoked permission, cutoff denial, two same-key requests, PostgreSQL durable effects and synthetic Chromium response-loss reconciliation. This is only a **private engineering staging mechanism**, not owner-editable business policy; #285 remains OPEN, as do administrator/employee mutations, owner time-only reschedule, public booking (#222), security and real-person data/pilot/production gates.
