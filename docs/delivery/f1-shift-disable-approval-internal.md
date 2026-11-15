# F1 controlled disable of future published shifts — partial #20

**Status:** private commands and synthetic PostgreSQL integration only.
No live owner UI, real session, PII, payment or production rollout.

## F1 scope: safe deactivation under owner-selected mode

An already-approved tenant policy in
`cookie_scheduling.schedule_edit_policies` (migration 0014) selects
`direct` vs `approval` for **published-shift time changes**. This
incremental slice extends the same setting to **disabling a future
published shift**. No additional toggle is invented. If no tenant policy
row exists, mode defaults to `approval@revision0`. The owner mode
setting is still owner-only with CAS audit. Draft creation/edit, shift
publication, schedule breaks and assignments remain OUT OF SCOPE.

### Direct

`disableShiftDirectInternal(pool,input,assertMayDisable)` is the only
prospective operator-facing direct adapter. It wraps existing
`disableShiftInternal`, checks tenant mode=`direct` inside the same
SQL transaction via Organization row FOR SHARE, and preserves the
mandatory trusted policy callback, `schedule.manage` auth, staff row
lock, future-only checks and **Confirmed Booking occupied interval
(including post-service buffer) alternative-shift coverage**.

### Approval

`requestDisableShiftInternal` accepts a server-verified TrustedActor,
tenant-owned published shift ID, optimistic `expectedPublishedRevision`
and a per-actor/per-tenant SHA-256 hashed idempotency key. It resolves
staff/location from authoritative DB, takes StaffProfile lock before
ShiftWindow lock, validates scope and current approval policy and
records **only a pending request**, storing original start/end and
published revision for optimistic approval. A request does NOT alter
ShiftWindow, availability, customer Booking or booking prices.

`reviewDisableShiftInternal` is only callable by the **actual active
Organization owner** with org and relevant staff/location
`schedule.manage` access; role names alone never grant owner rights.
When approving, it **rechecks live requester authorization**, current
policy mode and revision, shift identity/location, active state, and
both original UTC interval boundaries + published revision. Any stale
request is denied before the underlying shift command.
It then calls the existing booking-safe `disableShiftInternal` on the
SAME PostgreSQL client and transaction. Successful shift disable,
its append-only audit, outbox, idempotency receipt, terminal request
`applied` status and second outbox event commit together.
If any check fails or late outbox insertion fails, the request remains
`pending`, shift stays active and the original Booking remains intact.
A reviewer may always **reject** a still-pending request, even after
policy mode changes, without changing the shift or bookings.
Terminal decisions cannot be overwritten. Identical-key retries return
the original committed decision, including after shift deactivation.

### Persisted contract

Additive migration `0015_schedule_disable_approval.sql` adds
`schedule_disable_requests`: tenant/requester/hash-scoped idempotency,
authoritative shift/staff/location, expected published revision +
absolute UTC interval, policy revision, pending/applied/rejected
state, verified reviewer ID, hashed decision key, terminal timestamp
and applied receipt. No unstructured reasons or PII are stored. All
migrations 0001–0014 remain byte-for-byte unchanged. Schema and
synthetic backup/restore smoke validate **15** migrations.

### Synthetic integration

Real PostgreSQL tests cover:
- default approval refuses direct disabling;
- unauthorized scoped manager, foreign tenant and non-owner reviewer;
- same-key concurrent request submission and review; changed-key
  / changed-input replay refused;
- pending request leaves published shift active; Confirmed booking
  including buffer blocks approval when no alternate shift covers it;
- alternative active same-branch shift permits safe approval without
  touching the original Confirmed Booking;
- forced late outbox conflict **AFTER underlying shift deactivation**,
  proving full rollback of disable, all audits/receipts and request
  decision, followed by a successful retry;
- mode switch invalidates pending approval but allows direct disable;
  reject stale pending request remains available;
- switch back to approval revokes direct disable; requester role
  revocation before review blocks an otherwise valid request;
- per-tenant exact event, request and audit cardinality.

### Security and production restrictions

These are strictly server-internal primitives; the original
`disableShiftInternal` is still trusted-only and MUST NOT be exposed
through public routes, agents, plugins or UI. Future adapters MUST
route through `disableShiftDirectInternal` or
`reviewDisableShiftInternal`. Shared PoolClient is internal
composition, never a client-controlled input.
Real authorization verification and SQL least privileges/RLS remain
mandatory before exposing any command. Existing direct SQL writers
could bypass locking and the mode. Notifications and human approvals
are not connected to a real interface. Other schedule mutations
still require mode-aware approval. Issue #20 remains OPEN.
