# Independent F1 QA — opaque session revocation before Booking mutation

**Scope:** an isolated synthetic Fastify Booking POST connected to the real (internal-only) PostgreSQL opaque Telegram session verifier and trusted Telegram↔Identity link resolver. No production API registration, customer proof, credentials, deployment or code changes.

## Hypothesis and security invariant

Unlike the transactional role/membership authorization policy in #113, HTTP AuthN verification happens *before* the Booking transaction. The resulting TrustedActor has no session token or link ID, so the Booking command can validate role permission without observing a bearer-token revocation or Telegram unlink committed after the AuthN read but before the command starts.

A Booking POST must not commit after the **exact session or source Telegram link** was revoked, unless a reviewed transaction boundary guarantees the Booking commit linearizes ahead of revocation.

## Test

`apps/api/test/opaque-session-booking-revocation-qa.integration.test.ts`:

1. Insert synthetic real PostgreSQL tenant, Identity, active Membership/role, Customer, service, staff and shift; create a trusted Telegram link and exchange a correctly signed synthetic Telegram `initData` through the real resolver for an opaque bearer.
2. Mount only opt-in test Booking routes, injecting the real session verifier via a test-only wrapper.
3. Pause immediately **after successful real opaque bearer verification**, before the HTTP adapter receives claims.
4. From a separate PostgreSQL connection, commit either (a) `revokeBearerToken` or (b) unlink `telegram_identity_links.revoked_at` (including its session-revocation trigger). Independently reverify that the token is now invalid.
5. Release the checkpoint. Require HTTP 401 or 403, **zero** Booking rows, **zero** command receipts and **zero** outbox events. This exercises a strict ordering in which revoke COMMIT precedes any business mutation.
6. For cross-check, use a fresh one-time signed proof and session for the unlink case.

A test failure demonstrates a security integration gap in the **test-only opt-in HTTP wiring**; it is **not** evidence of a public/live exploit (normal API bootstrap does not mount these routes). We must not call #113 closed on the strength of successful role-only races.

## Evidence gate

- Base: `main` at `bbac235697ce20bf7cd5a175b197f8a513f979cf`, after #156 merged.
- Command: `TEST_DATABASE_URL=postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci pnpm exec tsx --test --test-concurrency=1 apps/api/test/opaque-session-booking-revocation-qa.integration.test.ts`.
- CI: `.github/workflows/f1-ci.yml` must run real PostgreSQL 16. A lint/format/fixture failure is not a confirmed security gap; inspect exact output and only claim RED after test reaches its invariant assertion.
- The QA PR is expected to be kept Draft until a reviewed architecture change ensures session revocation/write linearization and the same tests pass. Any correction belongs to backend/Identity agents, not this QA branch.
- No consent/real customer-linking, public login, CSRF/cookies or production rollout is authorized.

Related #113, #18, #66, #146, #156.
