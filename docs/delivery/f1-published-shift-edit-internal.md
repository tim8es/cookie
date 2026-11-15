# F1 protected editing of already-published future shifts — partial #20

**Status:** internal synthetic PostgreSQL command. Not a production
admin calendar or public endpoint.

## editPublishedShiftInternal

`packages/domain-scheduling/src/edit-published-shift.ts` provides an
internal time-window-only edit of a future `active=true` ShiftWindow,
previously published through the audited `publishShiftInternal` path.

The command:
1. Requires verified server-origin `TrustedActor`; tenant-scoped stored
   StaffProfile/Location relations and `schedule.manage` authorization.
   Neither staff nor location may change in the payload.
2. Locks the StaffProfile row **before** the ShiftWindow row in PostgreSQL,
   the exact protocol shared with CreateBooking/RescheduleBooking/
   CancelBooking and other protected schedule mutations.
3. Rejects an already-started shift, a new start in the past, malformed
   non-UTC-minute input, zero/>48-hour duration, missing/invalid IANA timezone,
   inactive/not-bookable staff or inactive staff/location assignment, and
   a missing required transactional `AssertMayEditPublishedShift`
   approval/entitlement callback (no permissive production default).
4. Rejects an active legacy SQL-created row without an authorization
   `shift_publish_audit` record or a previously disabled/re-activated row.
   Re-publication after disable requires separate reviewed rules.
5. Requires an `expectedPublishedRevision` compare-and-swap revision.
   This is **independent** of the prior `draft_revision`; a verified
   publication starts at revision 0. Two edits at the same revision cannot
   both commit; a changed request with the same idempotency key fails.
6. Rejects a NEW shift interval if it overlaps an active shift at a
   different Location for this StaffProfile. This is the **conservative
   technical F1 restriction**, not an accepted final F2 policy for
   overlapping multi-location shifts; there is no travel-time computation.

### Booking preservation (including post-service buffer)

For each future `Confirmed` Booking whose whole occupied interval overlaps
the **old** shift interval at the edited staff/location, the command
proves that its **entire** `[start_at, occupied_until)` interval is fully
inside either the **NEW** shift interval OR a separate active shift at the
**same Location**. If any would lose coverage, it rejects the edit
(`PUBLISHED_SHIFT_BOOKING_CONFLICT`) and leaves the shift and every
Booking unchanged. Booking duration, price, discounts and customer data
are never mutated or re-quoted.

Other active same-location shifts may preserve already-confirmed visits.
Overlapping shifts across different Locations are rejected as in PR #69.
CreateBooking and RescheduleBooking share the same staff row lock, so an
edit cannot race a newly committed booking and invalidate its slot,
provided all writers follow that lock protocol.

### Atomicity and audit

Additive migration `0013_published_shift_edit.sql` adds
`shift_windows.published_revision`, tenant+verified-actor+SHA-256
idempotency receipts and append-only old/new UTC window + revision audit.
No historical 0001–0012 migration changes.

A successful edit commits the ShiftWindow update, successful audit row,
privacy-safe `schedule.shift.edited` transactional outbox record and
idempotent receipt in **one database transaction**. An outbox failure
rolls back all of them; a retry using the original key can recover.
The same key after subsequent revisions returns the original result
after fresh authorization, not a new write. No external delivery occurs
inside the transaction.

## Tests

Synthetic PostgreSQL integration tests:
- forbidden actor, foreign tenant, invalid interval, policy denied,
  no-op and optimistic stale revision;
- uncovered Confirmed Booking rejected even if only its **postbuffer**
  extends past the shortened shift, and shift start changes cannot
  invalidate a visit;
- cross-branch overlapping active window rejected;
- safe edit with Confirmed Booking intact, parallel same-key replay;
- forced late outbox collision after the UPDATE: whole transaction
  rolled back, followed by same-key retry;
- alternative active same-location shift preserving a Booking while
  the original shift shrinks;
- two distinct concurrent edits on one revision (exactly one commits);
- CreateBooking competing with an edit of the only available future
  shift (exactly one commits);
- refusal of unaudited legacy active shifts;
- audits/receipts/outbox cardinality; 13-migration checksum and isolated
  PostgreSQL backup/restore smoke.

## Remaining limitations (no production/pilot)

No real authenticated API route, trial/paid entitlement adapter, owner
direct-edit vs approval-request review workflow, staff/location assignment
change protection, safe timezone change, recurrence/DST authoring,
RLS/least-privilege isolation or protected direct-SQL access. Direct SQL
writers could bypass the staff lock, making this handler's guarantee
insufficient for production until DB privileges enforce the contract.
Do not use with actual PII, real providers, payments or live salons.
Issue #20 remains OPEN.
