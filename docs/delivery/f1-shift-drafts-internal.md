# F1 protected creation and editing of future shift drafts — partial #20

**Status:** internal synthetic-only PostgreSQL command. Not a public
scheduling API, self-service calendar, real operator identity or pilot.

## Operations

`createShiftDraftInternal` and `editShiftDraftInternal` in
`packages/domain-scheduling/src/draft-shift.ts` are separate commands.
They require a **verified server-side TrustedActor** and non-optional
trusted policy callback (`AssertMayChangeDraft`) to enforce organization
approval/entitlement rules within the SQL transaction. No permissive
production adapter is available. Both require `schedule.manage` on the
tenant's actual Location/Staff relation, validate IANA timezone and active
staff/location assignment, accept UTC minute timestamps and require a
future duration of 1–2880 minutes. No recurring schedule or ambiguous DST
wall-time parsing is attempted.

Create uses the tenant/staff row lock shared with CreateBooking,
RescheduleBooking, CancelBooking, protected AddScheduleBlock, DisableShift
and PublishShift, inserts a NEW ShiftWindow with `active=false` and
`draft_revision=0`, then commits audit/outbox/receipt atomically.
A draft must NOT expose availability, even if it overlaps other drafts.
Idempotency key is scoped to tenant, actor and `create` operation.

Edit resolves immutable staff/location IDs from tenant-scoped persistence,
locks StaffProfile first, then the draft shift row, reauthorizes and demands
**create provenance from the new F1 audit**. A legacy inactive row with
ambiguous history, an active/published shift or a previously disabled
shift **cannot be edited through this command**. Editing changes only the
time interval; it cannot change StaffProfile, Service, Location, actor,
active state or customer bookings. The API must pass `expectedRevision`;
a distinct concurrent edit cannot silently override another edit. A
successful edit increments `draft_revision` by 1. Same-key retry returns
the original committed result even if later revisions/publishing occurred,
provided the trusted actor remains authorized. Identical-interval edits
are rejected rather than creating fake audit history.

## Data / atomicity

Migration `0012_shift_drafts.sql` is additive. Existing migrations
0001–0011 are immutable; it adds `shift_windows.draft_revision`,
`shift_draft_audit` (actor/correlation, old/new absolute intervals,
old/new revisions, create/edit action), and
`shift_draft_receipts` (tenant+actor+operation+SHA-256 key,
request hash, original result, shift reference). No client contact,
PII, names, raw idempotency key or arbitrary narrative is stored.
Within the command transaction, shift create/edit, success-only
append audit, privacy-safe outbox event and idempotent result receipt
either all commit or all roll back. No external provider is called.

Publication continues to be handled ONLY by the separately authorized
`publishShiftInternal` (#69): it rechecks active assigned Staff, IANA
timezone and overlapping shifts across other branches. Neither creating
nor editing a draft circumvents that guard. Closing an active shift remains
the responsibility of `disableShiftInternal` (#63). A change to an
already-published shift needs a separate reviewed workflow — direct
in-place edits remain forbidden.

## Synthetic integration evidence

The fixture tests cross-tenant/unauthorized rejection, strict UTC/range
validation, mandatory policy denial, parallel same-key create/edit,
reused-key mismatch, unpublished draft not available for a Booking,
late outbox failure **after UPDATE** rolling back new revision/audit/receipt,
successful same-key retry after removing the synthetic error, two
distinct-key concurrent edits at one revision (exactly one succeeds),
authorized publish of the final revision enabling CreateBooking,
a later edit denied, overlapping draft in a second branch denied by
PublishShift, and conservative refusal of unaudited legacy drafts.
Migrations and PostgreSQL synthetic backup/restore smoke now expect 12.

## Open release gates

- Real verified session/AuthN; customer/guest identity proof and tenancy
  RLS/least privilege; no unguarded direct SQL writes for published data.
- Owner-selected **direct-edit vs approval-required** scheduling workflow,
  including durable requests and review, notification, exception policy
  and proper revocation under concurrency.
- Edit/publish of already active shifts, import/legacy migration policy,
  real staff assignment deactivation, location/timezone changes, recurrence
  and DST gap/fold UX.
- Real commercial entitlements, discounts and promo redemption, payments,
  provider integration and public booking API.
- No production deployment or real PII is authorized. Issue #20 remains
  OPEN until end-to-end authenticated scheduling and booking are verified.
