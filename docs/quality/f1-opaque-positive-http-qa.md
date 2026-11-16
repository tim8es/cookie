# F1 #165 — positive HTTP control for the canonical opaque Cookie bearer

**Scope:** independent QA-only test on backend PR #173 at current source head `ef36fe28cc745e57dc9b12fb3e2c6c20fcc6480c`. Nothing is mounted by normal production API startup.

`apps/api/test/opaque-session-positive-http.integration.test.ts` uses real synthetic PostgreSQL 16 + signed Telegram initData + an existing trusted consented link + the actual PostgresOpaqueTelegramSessions provider. It mounts the opt-in Fastify Booking adapter and sends a request with a valid issued bearer.

Acceptance is strict:
1. First POST must return HTTP **201** with a **Confirmed** Booking and generated Booking ID.
2. Replay with the same idempotency key must return the same committed receipt, without a duplicate Booking, receipt or Outbox.
3. Exactly one Booking, one receipt and one Outbox event must exist after the two POSTs.
4. Revoke the exact bearer, independently reverify `null`, resend the same otherwise-valid POST and demand **401/403**, with the three persistent counts unchanged.

This positive control is complementary to QA #162/#172 revoke-first/expired-link negatives and QA #174 membership-disable lock cycle. It guards against an incorrectly blanket-denying security fix. Synthetic data only; no live Telegram, real customer data, payments or production deployment.

**Status: UNVERIFIED until exact-head full GitHub F1 CI finishes.** Require no skipped tests, source format/lint/typechecks, real PG and browser gates. Exact event/receipt assertions are not weakened if a failure occurs.
