# F1 Scheduling — provisional availability

This independent domain module implements a **pure read-side** calculation for
Issue #20 (REQ-002, REQ-029/030/033/034, ADR-0003). It is deliberately not a
booking engine, public API, authentication layer, SQL migration, or replacement
for the atomic booking checks required by Issue #21.

## Inputs and trust boundary

The server-side Scheduling adapter must:

1. Authenticate/authorize the request and scope all read ports to the trusted
   Organization, Location, StaffProfile and permitted Service assignment.
2. Resolve the location's shifts, breaks and exceptions to **absolute UTC**
   intervals using its IANA timezone. For nonexistent or duplicated wall-clock
   times, use an explicitly reviewed disambiguation policy at that adapter
   boundary; this module will not guess one.
3. Load **all active occupied intervals for the staff across all Locations of
   the same Organization**, including stored post-service buffers. A query
   limited to the requested Location would allow duplicate availability.
4. Supply the single catalog Service duration and post-service buffer. The
   service duration is shared across assigned staff and locations.

The evaluator deliberately rejects inconsistent tenant/staff occupancy data
rather than silently dropping it. It cannot prove that the adapter loaded a
complete, authorization-checked snapshot. Dates and times are UTC instants;
the selected IANA timezone is used to filter each requested **localDate**.
Each returned `startAt` is an unambiguous UTC instant (including during DST
fall-back). Slots follow a configurable per-shift time step; that grid and
the current hard bounds on window/minutes are **F1 implementation choices**,
not finalized product defaults.

## Interval rule

Client-facing service time is `[startAt, endAt)`, while occupied staff time
is `[startAt, occupiedUntil)`, with post-service buffer included. Shifts must
contain the *whole occupied interval*. Breaks, exceptions and confirmed staff
occupancies disallow any overlap of occupied intervals. Adjacent half-open
intervals are allowed. No automatic travel buffer between branches.

## Important limitations / remaining work

- `listAvailableSlots` is provisional. A returned slot can become unavailable
  before `CreateBooking` commits.
- The Booking command must reload permissions, service assignments, schedule,
  price, entitlements and all-location occupancy **inside the same PostgreSQL
  transaction** that creates the Confirmed booking. Database-level exclusion
  and deterministic staff locking still must be implemented and concurrency
  tested under #19/#21.
- There is no persistent Catalog/Staff/Scheduling schema, safe schedule-edit
  transaction, CRUD endpoint, or DST wall-time recurrence resolver in this PR.
- No production rollout, real personal data, paid providers or Telegram
  integration are enabled.

Validation: unit tests cover half-open overlap, cross-location staff conflicts,
post-buffer, excluded intervals, local-day filtering, DST transitions and
fail-closed invalid input. CI also runs typechecking, boundary and formatting
checks for the new source.

## F1 persistence foundations (migration 0004)

`db/migrations/0004_catalog_staff_scheduling.sql` adds the first persisted
model for Catalog/Staff/Scheduling. One tenant-owned Service stores the only
duration and post-buffer; one tenant-owned StaffProfile can be assigned to
multiple Locations, with per-location Service assignments. All foreign keys
that connect these tables include `tenant_id`. Base Service price is stored
as integer RUB kopecks; F2 price overrides, discount ordering and persisted
Booking price snapshots are **not implemented** by this migration.

A Location gains nullable `time_zone`; null means **not configured**, not UTC.
The persisted value is syntax-checked but must additionally be validated as an
IANA timezone when written through a trusted server command. Shift windows
and blocked windows are absolute PostgreSQL `timestamptz` intervals; recurring
local rules and ambiguous wall-time conversion are not implemented. Service,
location and schedule assignments default to inactive to avoid accidental
publication before authorization and entitlement controls exist.

The SQL schema does NOT implement PostgreSQL RLS, authenticated CRUD/read
ports, change auditing, safe schedule edits, or concurrent Booking protection.
An internal caller with a broad DB role can bypass tenant-filtered queries;
only trusted scoped commands may use these tables before those controls exist.
Availability must **not** be served publicly until all-branch active booking
occupancy and the atomic CreateBooking protocol are integrated.

Integration coverage:
`apps/api/test/catalog-scheduling.integration.test.ts` creates synthetic
two-tenant data in a rollback transaction and checks composite FK denials,
cross-location staff assignment, service duration/price/buffer, invalid ranges,
break/exception kinds and inactive defaults. Those tests do not establish
production readiness or booking concurrency safety.
