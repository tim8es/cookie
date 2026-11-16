# F1 independent QA — opaque session expiry before Booking commit

**Status: UNVERIFIED** on this separate QA-only stacked branch until exact-head PostgreSQL 16 CI confirms the expected result. This is an extension of the two-mode [QA PR #162](https://github.com/tim8es/cookie/pull/162), not a production endpoint or an independent provider.

## Invariant and distinction

[Security issue #165](https://github.com/tim8es/cookie/issues/165) already contains reproducible bearer revocation and trusted Telegram-link unlink races. This follow-up tests a *distinct authority loss*: the specific Cookie opaque session expires before a pending opt-in Booking POST resumes, even though its membership, role grants, signed Telegram exchange and link remain valid.

A successful session verification outside a Booking transaction is not by itself sufficient to authorize business mutation after that session has expired. For the proposed strict F1 gate, if the verified credential has expired before the protected mutation starts, the request must fail with HTTP 401/403 and commit no Booking row, idempotency receipt or Outbox event. A future reviewed linearization policy may refine boundaries, but cannot silently accept expired authority.

## Deterministic PostgreSQL interleaving

1. Use the original #162 synthetic DB fixture: tenant, Identity, membership and role with `booking.create`, Customer, staff, service, shifts, trusted Telegram HMAC link.
2. Exchange a newly signed synthetic Telegram `initData` through the real resolver and obtain a fresh opaque bearer.
3. Intercept the successful `PostgresOpaqueTelegramSessions.verifyBearerToken` result *before* its already-verified claims reach the protected Fastify Booking adapter.
4. In independent, committed PostgreSQL SQL, update the exact session row by SHA-256 token digest and tenant ID: set `issued_at` to database time minus 610 seconds and `expires_at` to database time minus 1 second. Both values preserve the real DB lifetime CHECK `expires_at > issued_at`. No sleeps or wall-clock expiry wait is required.
5. Verify directly through the real provider that the same bearer now returns `null`, then release the held successful preflight result.
6. Require HTTP 401/403 with zero Booking, command receipt and Outbox rows. The original bearer-revocation and Telegram-unlink cases run in the same test with independent idempotency keys and distinct non-overlapping slots. Any different observed state is a real RED, not a PASS to be waived.
7. Clean up all synthetic rows and connections in `finally`.

## Reproduce

- File: `apps/api/test/opaque-session-booking-revocation-qa.integration.test.ts`.
- Parent: QA #162, head `2ccbddc5bf46eac0affae2c270b91eeb149636f5`; this PR changes tests and docs only.
- Node 26 / pnpm 10.24.0 / real PostgreSQL 16.
- Targeted: `TEST_DATABASE_URL=postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci pnpm exec tsx --test --test-concurrency=1 apps/api/test/opaque-session-booking-revocation-qa.integration.test.ts`.
- Full: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm test:integration`; normal F1 CI also includes restore, worker, web, browser.
- Record exact tested SHA, CI link and actual per-mode outcome after execution. Parent #162's already-confirmed RED is not evidence that this new expiry mode executed.

No backend repair by QA; no real users, real Telegram bot, credentials, deployment, payment or commercial pilot. Related #165, #113, #18, #22, #66.
