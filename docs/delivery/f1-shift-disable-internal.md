# F1 protected shift deactivation (partial Catalog/Staff/Scheduling #20)

**Status:** internal synthetic PostgreSQL engineering, not an administrator
API, real salon scheduling system, or production deployment.

## Command: disableShiftInternal

`packages/domain-scheduling/src/disable-shift.ts` accepts a server-verified
TrustedActor, a tenant-scoped `shiftId` and a key scoped to tenant/actor.
It is **not mounted by the API**. The command gets the authoritative staff
and location relationship from persisted `shift_windows`, acquires the
tenant/staff row lock shared with CreateBooking, RescheduleBooking,
CancelBooking and AddScheduleBlock, then locks the target shift.

After `schedule.manage` authorization at the actual staff/location, the
command applies a mandatory `AssertMayDisableShift` trusted policy callback.
No permissive implementation is provided; trial/entitlement, approval,
publication and local business exceptions remain F2/production gates.
The command refuses already inactive or already-started shifts.

A future Confirmed Booking's **whole occupied interval including its post
service buffer** must still fit inside at least ONE other active shift at the
same tenant/staff/location after the target shift is disabled. It examines
the current Confirmed bookings whose occupied interval overlaps the shift
being removed and rejects the change if any would lose full coverage. The
staff lock makes this safe against concurrent Create/Reschedule in all
branches, assuming every business mutation respects the shared lock. The
check is deliberate fail-closed: it does not delete/cancel/reschedule existing
confirmed bookings or silently split a visit across multiple shifts.

The state transition, minimal append-only
`cookie_scheduling.shift_disable_audit`, immutable successful
`shift_disable_receipts` (SHA-256 of key/request, no plaintext key) and
privacy-safe `schedule.shift.disabled` outbox event commit in ONE SQL
transaction. A same-key replay returns the original receipt only after
reauthorization. A different key cannot repeat a completed transition.
The migration is additive `0010_shift_disable.sql`.

## Verification

Synthetic PostgreSQL integration covers:
- refusal when a confirmed visit would be orphaned,
- active alternate shift covering the whole occupied interval,
- unauthorized actor and foreign tenant rejection,
- mandatory policy rejection preserving the old shift,
- concurrent same-key replay, reused-key mismatch and inactive-key rejection,
- confirmed Booking remains intact with alternate coverage,
- race between disabling the only shift and creating a booking in that branch:
  exactly one can commit, regardless of lock winner,
- exactly one committed audit, receipt and outbox event per shift disabled,
- migration count 10, backup/restore smoke and standard CI checks.

## Deliberate limitations

Only **future shift deactivation** is covered. Creating/publishing/editing
shifts, deactivating/altering staff/service assignments, updating IANA zones,
changing an existing block, or deleting scheduled data are NOT guarded by
this handler. Direct SQL writers bypassing the shared staff row lock can
still create schedule inconsistencies; least-privilege DB roles, RLS,
operational authorization and mutation audit are not complete.

This command does not solve Customer↔Identity proof, self-service deadlines,
real trial/paid entitlements, promotion redemption restoration or refunds.
Do not deploy or process real PII or paid clients before separate approval.
