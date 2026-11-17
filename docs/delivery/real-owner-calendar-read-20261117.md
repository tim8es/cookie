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
