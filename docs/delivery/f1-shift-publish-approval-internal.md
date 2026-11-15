# F1 owner-controlled future shift publication — partial #20

**Status:** private trusted commands and synthetic PostgreSQL only.
No public API, real session, active business tenant, provider or commercial pilot.

## Modes, safe policy boundary

The tenant's owner-managed `schedule_edit_policies` (0014) sets
`direct` or `approval` for published-shift edits, shift disable,
**and now publishing an F1-audited future draft shift**. An unconfigured
policy defaults to `approval@revision0`, so direct publication remains
denied until a verified owner explicitly chooses `direct`.
No separate product-facing owner preference or approval semantics
are invented.

### Direct publication

`publishShiftDirectInternal(pool,input,assertMayPublish)` wraps the
existing protected `publishShiftInternal`, checking current tenant mode
inside the **same SQL transaction** before the write. Its original
`schedule.manage` tenant/staff/location permission, staff row lock,
future time, active staff+assignment+bookable and valid IANA timezone,
no reactivation, different-branch overlap and required trusted policy
callbacks still apply. The original lower-level publish primitive is
**internal only**, NEVER for HTTP/agent/UI exposure.

### Publication request and owner review

`requestPublishShiftInternal`:
- requires a verified TrustedActor and `schedule.manage` over actual
  persisted staff/location; staff lock then shift row lock;
- requires a future, inactive, F1-audited shift created by the trusted
  draft command (not an unaudited SQL row, previously published or
  disabled shift) with matching `expectedDraftRevision`;
- checks owner policy is approval before saving an inert idempotent
  `pending` request (tenant+requester SHA-256 key), the exact initial
  UTC interval, staff/location and policy revision.
- Does **not** set active=true, expose bookable slots, or alter bookings.

`reviewPublishShiftInternal`:
- requires actual active organization owner (not role title), org-wide
  and targeted branch `schedule.manage`;
- serializes reviews by locking the staff row and request, then
  **re-checks requester's live permissions**, policy mode/revision,
  current draft active=false and exact unchanged staff/location,
  interval and `draft_revision`;
- calls `publishShiftInternal` using the SAME trusted
  PostgreSQL PoolClient/transaction as review decision, rechecking
  current active staff/assignment, IANA zone, future window and
  **cross-location overlapping active shifts** at commit;
- commits publication state, existing publication audit/receipt/outbox,
  owner review decision `applied` and approval outbox together;
  on *any* failure, including a late outbox conflict **after publication**,
  all writes roll back, leaving the shift inactive and request pending;
- allows a terminal explicit owner **rejection** even when the pending
  request's policy or draft revision is stale; no shift mutation;
- replays same verified review key deterministically; different keys,
  actions or reviewers cannot silently overturn a terminal decision.

## Data and test evidence

Migration `0018_schedule_publish_approval.sql` introduces tenant-scoped
`schedule_publish_requests`: key/request digests, authoritative
requester/staff/location/shift, expected draft revision and UTC interval,
tenant policy revision, pending/applied/rejected state, reviewer,
terminal key digest/timestamp and applied result. No customer data,
raw key, freeform reason or sensitive payload. Earlier migrations
0001–0017 are immutable. PostgreSQL checksum test and isolated
backup/restore smoke expect **18** migrations.

Synthetic integration covers: default approval blocking direct publish,
unauthorized/foreign tenant, revision mismatch, concurrent request
deduplication, changed payload same key rejection, pending shift stays
inactive, non-owner reviewer denial, mandatory policy fail, forced
outbox collision after publication proving rollback of shift/audit/
receipt/request and safe retry, concurrent identical approvals,
slot booking succeeds only after publish, cross-branch overlap arising
during pending state denied, edited draft revision cannot be published
by stale request, policy change blocks old approval and enables
direct publishing, explicit owner reject after mode change,
switching back to approval, live requester role revocation and
audit/outbox/receipt counts.

## Scope/release gates

Approval currently covers: published shift time edits, published shift
deactivation, and publishing future F1-created drafts. Creation/edit of
drafts, breaks/blocked windows, staff assignment, timezone changes
remain outside mode-gated workflow. Real owner approval inbox, verified
AuthN, staff identity binding, least-privilege SQL/RLS, provider channels,
entitlements, public API and acceptance with real customers remain
unimplemented. **No production deployment or real PII**. Issue #20
stays OPEN.
