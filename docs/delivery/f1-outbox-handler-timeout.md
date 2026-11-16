# Cookie F1 — bounded ordinary Outbox handler (#19)

**Scope:** opt-in, synthetic-only reliability hardening. The existing `runTrustedPostgresOutboxWorker` may now receive a `handlerTimeoutMs` smaller than its `leaseMs` by **more than 100 ms**. The synthetic no-network worker opts into a 20-second handler deadline under its 30-second lease.

When the handler completes normally, the same current-token fencing ACK/fail behavior persists. A deliberate graceful shutdown drains a started handler, ACK/fails, then stops claiming. If a handler exceeds its deadline, its per-handler `AbortSignal` is aborted, but **the event is deliberately neither ACKed nor failed**: an uncooperative provider request may still produce an effect. The supervisor terminates with a sanitized abandoned-lease error, does **not** claim another event, and another worker may reclaim the row only after PostgreSQL lease expiry with a new fencing token. The old token can never ACK the reclaimed event. Only stable provider-side idempotency can prevent duplicate external effects.

The legacy adapter call without `handlerTimeoutMs` retains its prior behavior for backward compatibility. Timeout validation is synchronous before claims, and the maximum can never consume the entire lease. Worker failure messages and observers contain no payloads or tenant IDs.

## Verification

New unit tests cover invalid deadlines and legacy compatibility. New **real PostgreSQL 16** integration tests cover a permanently noncooperating handler, cancellation signal, an untouched leased row, reclaim with a new token, refusal of stale ACK, and successful final ACK; a second test proves graceful shutdown during processing still ACKs. The existing CI runs every unit and PostgreSQL integration file.

**Not a real channel:** No Telegram/SMS provider, production worker, customer personal data, payments or live deployment. Timeout cannot cancel an uncooperative external effect. Real provider-side idempotency, independent operational health, legal/PII and production packaging remain release gates; Issue #19 stays OPEN.
