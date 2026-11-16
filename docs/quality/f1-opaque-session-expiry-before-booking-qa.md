# F1 independent QA — opaque session expiry before Booking commit

**Status: CONFIRMED RED (Critical/P0)** at QA test head `6ed92e076eff441d20df1681e8c914140063196d`, [PostgreSQL 16 CI #43911338131](https://github.com/tim8es/cookie/actions/runs/43911338131). 100/100 unit PASS, 44/45 real PostgreSQL integration PASS, one expected security assertion FAIL; lint, Prettier and TypeScript PASS. This is an extension of the two-mode [QA PR #162](https://github.com/tim8es/cookie/pull/162), not a production endpoint or an independent provider.

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
- Actual CI output for tested SHA: bearer revoked: `denied=false`, cumulative Booking/receipt/Outbox = 1/1/1; session expired: `denied=false`, cumulative 2/2/2; Telegram link unlinked: `denied=false`, cumulative 3/3/3. Expected denied=true and zero rows in all three modes. Test failed specifically at the final deepStrictEqual security assertion, not due to formatting/fixture error. Targeted mode execution is proven by the recorded `session-expiry` mismatch.
- No bypass, skip or assertion relaxation. A future backend/Identity fix must make the unchanged test GREEN, and review must verify the reverse interleaving, protected reads, tenant scope and SQL lock ordering.

No backend repair by QA; no real users, real Telegram bot, credentials, deployment, payment or commercial pilot. Related #165, #113, #18, #22, #66.

## Independent backend-comparison evidence (2026-11-16)

- Original QA base #162 is **RED**: [run #43911762004](https://github.com/tim8es/cookie/actions/runs/43911762004).
- Full-green backend candidate #171 was independently verified with this **unchanged three-case assertion** on QA head `efff7b1aeef9771f34548a60b03f40cdd0156994`: [run #43913539063](https://github.com/tim8es/cookie/actions/runs/43913539063), 101/101 unit, 45/45 real PG and 46/46 web checks.
- To select one canonical implementation instead of merging overlapping #171 and #173, this QA-only PR is now targeted to [backend PR #173](https://github.com/tim8es/cookie/pull/173), which additionally implements reverse-direction locking and an independent real-PG regression. The three-mode QA assertions and fixture remain unchanged. **Outcome on #173 is unverified until new exact-head CI succeeds.**

All candidate results must stay tied to their exact combined commit/base SHA; a previously green #171 does **not** automatically prove #173. The suite is synthetic-only: no public Booking session provider, real Telegram/PII or production rollout.
