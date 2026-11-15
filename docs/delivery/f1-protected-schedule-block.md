# Cookie F1 — protected schedule blocks (partial Issue #20)

**Status:** internal engineering on synthetic PostgreSQL data. This is **not**
a public calendar editor, subscription-ready feature or production approval.
Source: `packages/domain-scheduling/src/block.ts` and the shared policy contract
`ProtectedResource.kind = "schedule"`.

## Narrow command: add a future break or exception

`addScheduleBlockInternal(pool, command)` adds a **future absolute UTC**
`break` or `exception` at one StaffProfile and Location. It does **not**
modify shift windows, existing events or booking statuses. The initial F1
calendar stores explicit absolute intervals (no recurring rules or ambiguous
local times); a configured valid IANA timezone is required for the Location.
The interval must be a positive duration no longer than 48 hours.

The actor must be verified by an independent trusted session pipeline and
have active `schedule.manage` permission scoped to the **actual**
`tenantId/locationId/staffProfileId`. For staff roles, the pure
authorization policy also requires an independently established matching
`staffProfileId` relation. The current PostgreSQL policy snapshot does not
yet materialize staff-to-Identity links, so a staff self-service editor
remains denied until that model is implemented. The approved Owner/admin
role may use this internal command only with trusted credentials and explicit
role permissions. This command must never be exposed to raw client or AI
arguments.

Inside one transaction, the command locks the StaffProfile with
`FOR UPDATE`, the **same staff lock** as CreateBooking, CancelBooking and
RescheduleBooking, and verifies the active staff-location assignment and
location timezone. It checks existing **Confirmed bookings at the edited
Location** for occupied intervals overlapping the block; intervals include
the post-service buffer and use half-open `[start,occupiedUntil)` semantics.
If a block would invalidate an existing confirmed visit, the entire
command rejects with `SCHEDULE_BOOKING_CONFLICT` and inserts nothing.

The block is local to its Location: blocking a staff member in branch B
cannot invalidate a still-valid confirmed booking in branch A. Other
locations remain subject to tenant-wide staff occupancy when booking.

## Idempotency

The server derives an internal UUID from SHA-256 of
`[tenantId,actorIdentityId,operation,idempotencyKey]` and stores **neither
the raw key nor customer data**. Same-key concurrent retries serialize on
the staff lock and return the same existing active block. Reusing that key
with changed interval/staff/location/kind is refused; a previously disabled
block is not silently reactivated. This is deliberately narrower than
durable command receipts for Booking: there is no independent retained
operation journal if an operator hard-deletes the block with direct SQL.
Production must forbid such out-of-band mutation via DB privileges and
supply a reviewed immutable mutation audit.

## Validation and limitations

Synthetic PostgreSQL tests cover same-tenant role denial, foreign tenant,
tenant/branch resource ownership, buffered confirmed booking conflict,
independent branch exception, same-key replay and mismatch, existing slot
unavailability, and a **concurrent CreateBooking vs ScheduleBlock** race:
both must never commit an overlapping active resource. A pure
authorization unit test validates tenant/location/staff relation scope.

Not implemented: editing/deleting an existing block, shifting/shrinking
working hours, owner-selected SELF_EDIT/APPROVAL_REQUIRED workflows, approval
revalidation, staff Identity↔StaffProfile binding, complete mutation audit,
permitted schedule publication/assignment changes, RLS/least-privilege DB,
public availability read API, notification adapters, real customer PII, or
commercial deployment. Direct privileged SQL writes can bypass the shared
staff lock; that remains a release-blocking access-control concern.
**Issue #20 remains open.**
