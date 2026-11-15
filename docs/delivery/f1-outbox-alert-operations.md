# F1 — controlled alert dead-letter replay and lease heartbeat (#19 / #38)

**Status:** internal operator/worker primitives on synthetic PostgreSQL only.
Not a public API, a production incident-management service, a real notification
adapter, or an approved global-operator authorization policy.

## Baseline and reason for this slice

The existing private alert queue stores every immutable reason transition in
a delivery row, with `pending`, `leased`, `delivered`, and `dead` states,
bounded attempts, rotating lease tokens and stable transition idempotency
keys. Once an alert reaches `dead`, it is intentionally no longer retried
automatically. Separately, a running handler with long work may need extra
time, but indefinite lease renewal can mask a stalled worker.

The additive migration `0018_outbox_alert_replay.sql` keeps all previous
migration history and introduces a `manual_replay_count` (max 3),
`lease_started_at`, a separate immutable logical replay audit and hashed
idempotency receipts. It does not modify the original alert journal or
change the event/tenant scopes of the business Outbox.

## Explicit operator replay

`replayDeadOutboxAlertDelivery(pool, request, assertMayReplay)` is a private
internal command:

- A server-verified `TrustedAlertOperator` with identity ID and
  correlation ID is required. **A salon Tenant Owner is NOT implicitly a
  global ops operator.** The mandatory `assertMayReplay` callback must
  independently enforce the reviewed global-operator policy, inside the
  same transaction. There is no default policy and no public endpoint.
- The operation checks that a delivery row is `dead` and has fewer than
  **three manual replays**. It resets only delivery state/attempts/lease
  metadata to `pending`; it **does not** edit the immutable transition
  journal and does not invoke any external notification provider.
- The count advances only when a replay actually occurs. One append-only
  audit row records the operator identity, correlation ID, transition ID,
  replay number and previous attempts. A failed audit INSERT rolls back
  the status update. Each successful/no-op command records an immutable
  receipt keyed by a **SHA-256 hash** of the operator-scoped idempotency
  key. The original raw key is not stored.
- An identical replay key returned after a lost COMMIT acknowledgement
  yields its original receipt even if the delivery status has subsequently
  changed. A reused key targeting another transition is refused. Concurrent
  identical keys serialize using a transaction advisory lock and row locks.
  A denied authorization callback aborts the command.
- Once the three-replay limit is reached, **no fourth automatic/manual
  replay** is allowed under this contract. Any extension needs a separately
  reviewed policy and schema change.

The operator identity is operationally sensitive internal metadata, not
end-customer data. The global operator identity/permission model has not
been approved or implemented yet; test-only authorization callbacks are
explicitly not deployable authorization.

## Bounded heartbeat and stalled handlers

`renewOutboxAlertDeliveryLease(pool, lease, extendMs)` extends one **active,
unexpired, properly fenced** lease. The current lease token must match.
`extendMs` is a validated positive integer up to 600,000 ms. Renewal
must genuinely extend the deadline; it cannot shorten it. Every fresh
claim stamps `lease_started_at`; the extension may not move the deadline
beyond **15 minutes from that attempt's first claim**. An expired,
superseded or legacy lease missing its start timestamp cannot be renewed.

After expiry the existing worker claim path may rotate the token and
increment attempts or dead-letter the item if exhausted. The old handler
cannot acknowledge, fail or heartbeat the new holder's lease. This is a
bounded safety mechanism, **not** preemptive cancellation of running code.
The worker must still respect its execution timeout and the future
provider's idempotency contract.

## Test evidence

Real PostgreSQL 16 tests verify:

- Two independent connection pools racing 12 same-key replay requests:
  precisely one mutation and replay audit, all identical outcomes.
- Explicit authorization denial, changed transition with the same key,
  three successful replays, fourth refusal, and original receipt recovery
  after later state changes.
- A test-only PostgreSQL audit trigger throws **after** delivery state
  update; the transaction rolls back fully. The same key succeeds when
  the failure injector is removed.
- Lease extension with current token, rejection of stale tokens,
  inability to shorten leases, rejection of expired/legacy leases,
  and hard 15-minute per-attempt cap.
- Invalid IDs, correlation IDs, keys and lease parameters rejected before
  database access; migration count and synthetic backup/restore checks.
- All synthetic tests use disposable rows and explicit cleanup.

## Remaining release blockers

No real operator AuthN/roles, no admin UI, no public replay endpoint,
no delivery/approval workflow, no actual provider-side duplicate suppression,
no production DB least-privilege roles, no real PII/notification channel,
no on-call runbooks or live deployment. `at-least-once` eligibility means
a provider could see duplicates after a crash between external acceptance
and acknowledgement; exact external effect requires verified provider
idempotency. Issues #19 and #38 remain OPEN.
