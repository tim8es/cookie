# F1 protected publication of draft shifts — partial #20

**Status:** internal PostgreSQL command and synthetic CI tests. **NOT** a
production-ready salon calendar, self-service API, human approval workflow or
permission grant. Based on F0-approved contracts, after PR #62/#63.

## Internal command

`publishShiftInternal(pool, input, assertMayPublish)` in
`packages/domain-scheduling/src/publish-shift.ts` takes only a server-verified
TrustedActor, an existing tenant-owned inactive ShiftWindow ID and a scoped
idempotency key. No staff, location, dates or active flag can be supplied by a
client to override the authoritative record.

The operation locks the **StaffProfile row first**, then the ShiftWindow row,
matching CreateBooking, RescheduleBooking, CancelBooking, AddScheduleBlock and
DisableShift. It checks `schedule.manage` authorization scoped to the
actual Location and StaffProfile, and requires a non-optional trusted policy
callback to check approval mode, entitlement and location/business rules.
There is no permissive production adapter.

It refuses publication of already-active or already-started shifts, shifts
whose StaffProfile is not active/bookable, whose staff/location assignment is
inactive, or whose Location IANA timezone is missing or invalid. It also
refuses to re-publish a shift already included in `shift_publish_audit` or
`shift_disable_audit` — reactivation requires a future explicit contract.

### Multi-location safety

F1 chooses a **conservative technical restriction**: reject a draft shift
if it overlaps ANY active shift of the same StaffProfile at a **different**
Location in the tenant. Same-location overlapping shifts remain possible
(e.g. overlapping coverage); confirmed booking double-allocation is still
blocked by Booking's cross-location GiST exclusion constraint.

This F1 restriction is a guard against offering an impossible simultaneous
multi-branch appointment window. It does **not** calculate transport time and
does **not** define the final product-level overlapping-shift policy
(REQ-030/DEC-042, pending review). The owner/admin still sets shift spacing.
It is important that historical SQL/untested writers can insert conflicting
active windows: production must use least privilege and guarded creation/edit
of shifts plus tenant-safe transactions before rollout.

### Atomicity and audit

A successful publish commits, in one SQL transaction:
- `active = true` on the original ShiftWindow;
- append-only `shift_publish_audit` (tenant, shift, actor, correlation),
- privacy-safe `schedule.shift.published` outbox event,
- `shift_publish_receipts` scoped by tenant/actor/operation key SHA-256
  with request digest and immutable committed JSON response.

Same-key repeats return the **original** success after reauthorization,
without new audits/events. A reused key for another shift fails, and a
different key cannot re-publish an active or historically disabled shift.
Failed policy, validation, conflict and rollback leave ShiftWindow inactive
and do not append successful side effects. No emails, providers or external
API requests occur within the SQL transaction.

## Synthetic PostgreSQL verification

Integration tests cover unpublished draft slots, conflicting cross-Location
windows, unassigned identity and foreign tenant, a required policy callback,
same-key parallel replay, changed request/new-key denial, success enabling
CreateBooking, denial of republishing a previously disabled shift, and a race
between two overlapping **different-location** shift publications proving
only one can commit. They verify one outbox/audit/receipt per successful
publication. Migration 0011 is additive and must be included in the
eleven-migration checksum and PostgreSQL backup/restore smoke test.

## Still open / no commercial deployment

- Protected draft ShiftWindow creation and editing, safe changes to
  StaffLocation/Service assignments, timezone changes and future recurring
  schedules/DST authoring are not implemented.
- Owner-selected direct-edit versus approval-required workflow, auth/session
  verification, customer/guest identity, RLS/least-privilege SQL roles,
  quotas/trial/paid entitlements, booking promotions, real notifications and
  real client-facing API are NOT implemented.
- Restrict or revoke direct SQL writers before any real pilot to make staff
  row locking an enforceable invariant rather than a convention.
- No real users, PII, payments, production data or providers were used.
  Issue #20 remains OPEN.
