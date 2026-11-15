# F1 owner-approved editing of existing future shift drafts (partial #20)

**Status:** internal synthetic-only scheduling commands. No real identity provider,
HTTP routes, approval inbox, production database privileges or pilot.

## Scope

Tenant owner's versioned `schedule_edit_policies` from migration 0014
now also controls **editing the UTC time interval of an existing F1-created,
not-yet-published draft**. This does NOT add approval for draft creation,
assignment changes or schedule blocks. Absent policy means `approval@0`
and denies direct editing by default.

- `editShiftDraftDirectInternal(pool,input,policy)` wraps the existing
  `editShiftDraftInternal`, checking `direct` mode **inside its own
  transaction**. It retains authoritative tenant/staff/location auth,
  only future audited inactive drafts, UTC minute granularity, 48-hour
  limit, expected revision, unchanged-rejection and trusted policy callback.
- `requestShiftDraftEditInternal(pool,input)` validates the requester has
  `schedule.manage` on the stored staff/location, current approval mode,
  a future F1-audited inactive draft and matching `expectedRevision`.
  The request contains the previous interval, proposed future interval,
  revision and owner-policy revision. Request submission does **not**
  change the ShiftWindow, reveal availability, or touch bookings.
- `reviewShiftDraftEditInternal(pool,input,policy)` requires the actual
  verified active Organization owner with org+branch `schedule.manage`.
  Approval rechecks the requester's LIVE permission, policy mode/version,
  shift's unchanged active state, location/staff, original UTC interval
  and draft revision. It uses the SAME PostgreSQL transaction/client for
  `editShiftDraftInternal`, request terminal decision, successful audit,
  receipt and outbox. Rejection simply marks a pending request rejected,
  even if the draft or policy has since changed.

### Locking, consistency and idempotency

StaffProfile `FOR UPDATE` lock precedes ShiftWindow/request row operations
and is shared with Create/Cancel/Reschedule Booking and previously merged
Scheduling commands. Organization row `FOR SHARE` locks protect against
concurrent owner-mode changes. The underlying command's optimistic
`expectedRevision` prevents last-write-wins. Reused tenant+requester
SHA-256 request key with different content is rejected. The owner's
hashed decision key makes review replays deterministic and prevents a
terminal decision being reversed by a different key/action/reviewer.

A forced late outbox error **after** the protected draft edit demonstrates
that draft revision/interval, audit, command receipt and owner review
status all roll back, leaving the request pending. On success, no split
state of "approved but unapplied" is possible. No raw idempotency keys,
client contact details or free-form notes are persisted.

### Data

New additive migration `0020_schedule_draft_edit_approval.sql` adds
`cookie_scheduling.schedule_draft_edit_requests`, with stable tenant,
requester/staff/location/shift references, policy and draft revisions,
previous and proposed UTC ranges, pending/applied/rejected states,
hashed decision key and applied result. Migrations 0001–0019 stay
immutable. PostgreSQL integration, checksum and isolated backup/restore
smoke require **20** total.

### Synthetic test matrix

Default approval refuses direct edit; requester denied on unauthorized
identity or tenant; invalid/non-minute interval and revision rejected;
concurrent same-key request deduplication; changed payload/key mismatch;
request remains inert; actual owner-only review; denied policy callback;
late outbox failure after edit proving complete rollback and safe retry;
concurrent same-key approved review; stale draft revision after an
independent edit; owner policy flip to direct invalidating pending review,
direct-mode editing and switch back; stale rejection replay; live requester
role revocation preventing pending approval; exact request/audit/receipt
and outbox counts.

### Release gates

The lower-level `editShiftDraftInternal` remains an INTERNAL trusted
primitive and MUST NEVER be exposed to a client, HTTP controller,
AI agent or plugin. Any future operator-facing integration MUST use
the mode-gated direct edit or owner-reviewed edit command; direct SQL
write privilege must be removed before any real usage.
Still missing: owner-approved **draft creation**, approval for blocks
and staff/location assignments, real AuthN, Identity↔StaffProfile binding,
SQL least privileges/RLS, approval UI and inbox, public calendar/
booking API, verified entitlements, notifications, recurrence/DST UX
and actual tenant validation. Do not deploy to production or store PII.
Issue #20 stays OPEN.
