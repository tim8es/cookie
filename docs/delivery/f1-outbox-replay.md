# Cookie F1 — controlled dead-letter replay and synthetic worker

**Scope:** internal-only incremental slice for [Issue #19](https://github.com/tim8es/cookie/issues/19). No live customer, PII, provider credentials, paid service, or production deployment authorized. Changes do not register any new HTTP or Telegram endpoint.

## Manual dead-letter replay (Owner only)

`replayDeadOutbox(pool, { actor, eventId })` is a **server-internal command**. Its `TrustedActor` MUST come from verified server-side authentication; it cannot be constructed from client headers, request JSON or an AI tool argument. It enforces `ownerProtected: true` and `outbox.replay` permission against the persisted active membership and owner identity using the existing Policy evaluator.

It begins a `SERIALIZABLE` PostgreSQL transaction, writes an authorization preflight event, locks the matching **tenant-scoped** outbox event, and only if its state is `dead` and the replay count is under three, resets it to `pending` with `attempts=0`. It appends an audit record with the actor, event ID, correlation ID, prior attempts, and replay number in the **same transaction**. A failed transaction rolls back both mutation and audit; a concurrent serialization failure fails closed. A denied access attempt in this code path does **not** imply a durable denial audit because its containing transaction rolls back.

**Important:** this is not a public admin command and there is no real session provider wired. The server must provide a verified actor when later integrating the command; the TypeScript shape alone does not authenticate someone. No time-based retention or auto-replay is set. The third replay is the last permitted by this baseline and repeated attempts cannot generate an unbounded delivery loop.

The event `id` and original `(tenant_id,dedupe_key)` remain unchanged through a replay. That preserves the stable external idempotency key while allowing new delivery attempts. **Exactly-once external side effects are not guaranteed.**

## Delivery adapter contract

`idempotentProviderHandler(port)` builds the same idempotency key (`outbox:<event uuid>`) for retry, lease recovery, or owner-authorized replay. `IdempotentDeliveryPort` explicitly declares support for stable provider idempotency keys and receives the event topic, tenant, payload and key. This **does not prove an external API respects** that key, and no Telegram/SMS/email/payment provider is connected. A future integration needs verification of provider deduplication guarantees, TTLs, timeouts, rate limits and safe reconciliation before handling live data.

## Separately runnable synthetic-only worker

The normal Fastify API does **not** start this worker. The synthetic-only command uses the pinned development TypeScript runner; **this is not a deployable compiled production bundle**. The current pnpm workspace does not package the compiled `dist` output with runtime node_modules, which remains a future release-engineering task. For local synthetic PostgreSQL only:

```sh
export COOKIE_SYNTHETIC_WORKER=enabled
export DATABASE_URL=postgres://cookie_dev:cookie_dev@127.0.0.1:5432/cookie_dev
pnpm dev:worker:synthetic
```

Alternatively CI can use the exact pinned `cookie_ci` test URL when `CI=true` and `TEST_DATABASE_URL` matches. Any other connection URL is rejected. The synthetic process claims **only** topic `test.synthetic` and verifies `payload.synthetic === true`; it performs no network operation and never handles `booking.confirmed` or other real notification topics. Its logs contain only counts. It stops on SIGINT/SIGTERM after the current event; since leases have no heartbeat, a hung handler could still block graceful termination. Do not put real contacts, payloads, or business work under `test.synthetic`.

## Validation / remaining gates

PostgreSQL integration tests use synthetic tenants and identities and check owner/role nondelegation, cross-tenant refusal, audit consistency, replay attempt caps, and topic filtering. Unit tests check opt-in guard and stable provider keys. Frozen CI includes the sixth immutable migration and synthetic dump/restore smoke.

**Open requirements:** actual trusted AuthN for operations, tenant-specific secure admin UI/API, replay approval workflow, real delivery adapters and idempotency guarantees, durable workers and monitoring/alarms, lease renewal/timeouts, DB privilege/RLS review, legal handling of personal data, encrypted/offsite backups and production incident restore evidence. Issue #19 remains **OPEN**.
