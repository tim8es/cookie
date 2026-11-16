# F1 owner-approved creation of future shift drafts — partial #20

**Status:** internal trusted PostgreSQL commands and synthetic test fixtures.
No public API, real user sessions, customer PII or commercial pilot.

## Owner-selected direct vs approval

The tenant-wide `schedule_edit_policies` mode from migration 0014
continues to apply to published-shift editing, disabling, publishing and
draft editing. This slice extends it to **creating future shift drafts**.
A missing policy row defaults to **approval@0**, so direct creation is
denied unless the verified owner explicitly configures direct mode.
This is a conservative F1 technical implementation; **REQ-028's eventual
per-master/per-role policy precedence and permitted administrator
reviewers are still an F2 design decision**, not silently resolved here.

- `createShiftDraftDirectInternal`: an internal adapter that runs the
  original protected `createShiftDraftInternal` with a **transaction-
  local direct-mode check** and the required trusted policy callback.
- `requestShiftDraftCreateInternal`: a server-verified actor with
  `schedule.manage` on persisted staff/location may request a future
  interval of 1–2880 minutes in exact UTC minutes, for active assigned
  staff and a configured valid IANA location timezone. It locks the
  StaffProfile and reads the organization owner mode using FOR SHARE.
  On approval mode it stores a **pending proposal only**: no ShiftWindow
  is inserted and NO booking availability is opened.
- `reviewShiftDraftCreateInternal`: only the actual current active
  Organization owner with organization-wide and target-branch
  `schedule.manage` may approve or reject. Approval rechecks
  the requester's **current** scoped permission, owner mode/revision,
  staff/assignment activeness, IANA timezone and future UTC interval
  through the authoritative protected create command at commit time.
  Rejection remains available even after a mode change.

## Atomicity and concurrency

StaffProfile FOR UPDATE is shared with booking and scheduling writers.
Owner mode uses an Organization row FOR SHARE lock, serialized against
mode changes holding FOR UPDATE. Duplicate submission is serialized by
the StaffProfile lock. The original core create handler accepts an
optional **trusted-only PoolClient** so approval's ShiftWindow insert,
draft audit, idempotency receipt, draft-created outbox, terminal
`applied` request and approval outbox commit in **one SQL transaction**.
If any check fails or a late outbox insertion collides, the operation
rolls back with request still pending and **no created draft**.
Same decision-key concurrent reviews return the original committed
ShiftDraft receipt. A different decision key/action may not override
a terminal result.

Request dedupe is tenant+requester scoped, keyed only by SHA-256 digest
of an external key, with separate request SHA-256 fingerprint.
The reviewer uses a deterministic internal key scoped to the pending
request; no raw keys, customer contacts, personal data, arbitrary
narrative, pricing or real provider calls are stored. A repeated
submission returns the original pending *submission receipt* after
reauthorization even if it was subsequently decided; terminal status
is obtained through the separate review workflow (future read API).
The request is a proposal only and does **not** reserve capacity.

## Data and synthetic QA

New additive migration `0021_schedule_draft_create_approval.sql` adds
`cookie_scheduling.schedule_draft_create_requests` with tenant,
requester, staff/location FKs, proposed UTC interval, policy revision,
pending/applied/rejected state, authenticated reviewer reference,
decision key digest/timestamp and stored successful creation receipt.
No `shift_id` FK exists before approval because the draft does not exist.
Migrations 0001–0020 stay immutable. Tests and isolated PostgreSQL
backup/restore now validate **21 migrations**.

Synthetic integration covers:
- unconfigured approval mode blocking direct creation;
- unauthorized/foreign-tenant submissions and malformed UTC/ranges;
- concurrent same-key request deduplication, key/payload mismatch;
- request does not produce any ShiftWindow;
- owner-only decision, denial by mandatory trusted policy callback;
- forced outbox collision **after** protected INSERT + audit + receipt
  with complete rollback and safe subsequent retry;
- concurrent same-key review replay, changed decision-key rejection;
- owner mode flip invalidating pending approval, direct-mode creation,
  reenable approval, terminal reject replay after flip;
- target assignment deactivation between request and review blocks
  approval, then requester's role revocation blocks approval;
- exact pending request, created draft, audit/outbox/receipt counts.

## Live-use blockers

These are INTERNAL primitives, never raw HTTP endpoints or trusted
AI/third-party callers. Direct SQL writers could bypass the mode and
staff locks until least-privilege DB credentials and RLS exist.
No staff self-service identity binding, owner request inbox/notifications,
F2 per-staff policy precedence, production entitlement/approval adapter,
schedule-block approval, protected assignment/timezone mutation,
authenticated public booking/calendar API, recurrence/DST authoring,
or real customer acceptance. Issue #20 remains OPEN. No production
deployment, real PII or paid providers are authorized.
