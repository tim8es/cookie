# F1 internal scheduling approval workflow (partial #20)

**Status:** synthetic PostgreSQL-only. These are internal commands, not
HTTP endpoints, real user identities or a live pilot.

## Owner-selected mode

`schedule_edit_policies` is tenant-wide for **published-shift time edits**.
If the owner has never configured it, mode defaults to **approval**, revision
0 (fail closed for direct editing). The **verified Organization owner** with
active membership and `schedule.manage` at organization scope may switch
between `direct` and `approval` via
`setScheduleEditPolicyInternal(pool,{actor,mode,expectedRevision})`.
Every change uses an organization row lock, CAS revision, append-only policy
audit and privacy-safe outbox in one transaction. Role labels, client
payloads or ordinary managers cannot impersonate the actual owner.

- **Direct mode:** `editPublishedShiftDirectInternal` calls the existing
  booking-safe `editPublishedShiftInternal`, with a required transaction-
  local check that policy is still `direct`. It retains all booking,
  buffer, cross-location, timezone, authorization and revision checks.
- **Approval mode:** `requestPublishedShiftEditInternal` lets an actor
  with `schedule.manage` for the actual stored staff/location submit a
  pending, idempotent request containing only the proposed UTC window,
  expected published revision and organization policy revision. **No
  availability or Booking changes happen on submission**.
  `reviewScheduleEditRequestInternal` allows only the actual owner to
  approve or reject. The reviewer must still have organization and
  branch `schedule.manage` authorization.

An owner rejecting a request records a terminal immutable decision,
without editing any shift. An owner approving a request **rechecks the
requester's current permissions**, policy mode/version, shift revision,
existing Confirmed booking coverage including postbuffer, cross-branch
overlap and every other guard in the prior safe editor. Approval executes
the editor on the SAME PostgreSQL PoolClient and transaction as the
request decision and outbox. Success commits both `applied` and actual
shift edit; failures (including late outbox errors) roll all of it back
and leave the request pending for deliberate re-review or rejection.
Approval cannot silently apply a stale request or bypass a revoked
requester's role. No "approved but unapplied" intermediate state exists.

Request creation/review are serialized via the staff row lock used by
Booking and Scheduling. Policy mutation obtains Organization FOR UPDATE;
request/direct edit/review obtains Organization FOR SHARE in the current
transaction, preventing mode-switch races. Individual reviews use
`schedule_edit_requests FOR UPDATE` and a hashed decision key, so
parallel same-key approval/rejection replays the original terminal
decision while a different action/key is refused.

### Technical scope and limits

Migration `0014_schedule_approval.sql` adds versioned
`schedule_edit_policies`, append-only `schedule_edit_policy_audit` and
`schedule_edit_requests`. All 0001–0013 migrations stay immutable.
Organization's actual ownership is read from authoritative tenant data.
No raw idempotency keys, PII, customer contacts, freeform reason text or
tokens are stored. Only absolute UTC intervals, UUID references and
minimal decision metadata.

**Important integration contract:** the legacy
`editPublishedShiftInternal` is a lower-level trusted primitive;
administrator/user-facing adapters MUST call the mode-gated
`editPublishedShiftDirectInternal` or
`reviewScheduleEditRequestInternal`, never expose the lower-level
primitive directly. The existing mandatory external
`AssertMayEditPublishedShift` policy callback remains required to
enforce entitlements/publication exceptions and does **not** imply a
working, externally authenticated API. Transaction sharing is an
internal trusted-only composition hook.

This F1 workflow applies ONLY to **editing a published shift's UTC
start/end**. New draft creation, publication, deactivation and schedule
blocks still need their own approved workflow policy integration.
User identity→StaffProfile binding is not implemented, so staff-scoped
self-service must remain denied until trusted mapping exists. There is
no public request listing, notification delivery or real admin approval
screen. Historical direct SQL changes can bypass staff-row locking;
DB least privileges/RLS are mandatory before live deployment.

## Synthetic CI verification

Integration suite tests default approval denial of direct editing;
owner-only mode changes, versioned CAS; request identity/tenant checks
and idempotent replay; pending request does not change availability;
reviewer owner check; policy deny; injected outbox failure AFTER protected
editor write proving full request+shift rollback; concurrent same-key
approval replay; confirmed Booking preserved; rejected unsafe shrink
including postbuffer; mode change invalidating old request; direct mode
permit; terminal reject replay even after mode changes; role revocation
between filing and approval; exact audit/receipt/outbox counts.
Backup/restore smoke and migration checksum now expect 14 migrations.

## Not production ready

Pending: session AuthN, binding staff identities, invitation/access UX,
RLS/SQL role hardening, approved workflow for other schedule actions,
calendar API/pagination, request expiry/cancel UX, review notifications,
worker delivery, tenant entitlements, real PII controls, deployment
approval and pilot acceptance. No real user data or paid providers used.
Issue #20 stays OPEN.
