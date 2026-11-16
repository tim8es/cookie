# F1 #19 — alert delivery expired-lease lock isolation

This internal, synthetic-only increment hardens the **alert delivery** queue
(`outbox_alert_delivery`), independently of the ordinary event queue
(`outbox_events`, PR #147).

Before the fix, `claimOutboxAlertDeliveries` ran a blocking UPDATE of
expired, attempt-exhausted leases before its `FOR UPDATE SKIP LOCKED`
claim. An uncommitted transaction holding one expired alert row could
therefore stall delivery of *unrelated due alerts*.

The preliminary cleanup now selects only currently unlockable rows using
a `FOR UPDATE SKIP LOCKED` CTE, and updates those rows to
`dead / LEASE_EXHAUSTED` while clearing their lease metadata. A skipped
row remains leased; a **later** claim sweep, after its transaction lock
has been released, finishes the transition. This is best-effort, eventual
dead-letter maintenance; there is no autonomous cleanup timer or
immediate dead-letter promise. Claim ordering, fencing tokens, bounded
attempts and the immutable alert journal remain unchanged.

## PostgreSQL proof

The real PostgreSQL 16 integration test seeds two distinct synthetic
alert transitions. One has an expired final-attempt lease and its delivery
row is locked using `FOR UPDATE` in an uncommitted transaction.
Another alert becomes pending. A separate worker connection has
`lock_timeout=300ms` and must still claim and ACK the ready alert.
The locked row must remain `leased` (same token and attempts) until
the lock is released. A later claim must sweep it to
`dead / LEASE_EXHAUSTED`, clear token/deadline and refuse stale ACK.

No migration, API, Booking, Identity, ordinary Outbox worker,
provider credentials, external network calls, production deployment,
PII or payments are part of this change. Real on-call delivery,
provider-side idempotency and deployment approval remain **OPEN**.
