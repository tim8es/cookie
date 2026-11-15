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
