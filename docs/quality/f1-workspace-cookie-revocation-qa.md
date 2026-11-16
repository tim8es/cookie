# F1 independent QA — revoke-first Cookie authority during protected Workspace GET

**Status: PASS — full exact-head F1 GitHub CI #43922036718 on test SHA `4fd6435946ad3a62e4fa2971a4165b139831e4ba`: 101/101 unit, 48/48 real PostgreSQL 16 integration, 46/46 web checks, migrations, backup/restore, worker/API build and Chromium smoke.** This test covers a *read path* absent from the existing Booking mutation security regression (#162/#172/#180) and role-snapshot Workspace QA (#175/#176). Stack on strict Workspace source fix [PR #179](https://github.com/tim8es/cookie/pull/179), parent SHA `abc892a452153841d5875fbb5a116f2cf19e7487`, itself stacked on canonical bearer guard [#173](https://github.com/tim8es/cookie/pull/173).

## Security invariant

An opt-in authenticated `GET /v1/organizations/:tenantId/workspace-context` must not disclose tenant organization name or location metadata when **the exact Cookie session, its validity interval, or its trusted Telegram link** is lost before the HTTP read's PostgreSQL transaction starts. A successfully verified bearer at HTTP preflight alone is not current authority.

## Real PostgreSQL 16 method

1. Create synthetic Organization, location, Identity, active Membership, one Owner Role with `booking.read`, RoleAssignment, and consented trusted Telegram↔Identity link.
2. Exchange independently HMAC-signed synthetic Telegram `initData` through the real Telegram proof verifier, trusted PostgreSQL resolver and opaque Cookie session provider. A normal GET using this bearer must respond **200** and contain the fixture organization and location names; this is a non-vacuous positive control.
3. Intercept only the **returned successful real `PostgresOpaqueTelegramSessions.verifyBearerToken` result** in a test-only verifier wrapper. Pause before forwarding those verified claims to the protected Fastify GET.
4. From another real PostgreSQL connection, commit one of three authority losses: `revokeBearerToken`; exact token expiry via a CHECK-preserving database-clock update; or durable Telegram link unlink. Independently verify the same bearer now returns null.
5. Release the successful HTTP AuthN preflight claims. Demand **HTTP 401/403** and **no organization or location metadata** in the response. A subsequent normal GET with the same bearer must get 401.
6. Repeat with distinct signed Telegram proof exchanges and tokens, then clean synthetic data/connections. No timing sleeps, real provider contact or PII.

Unlike the strict Workspace role-snapshot test, this is a **revoke/expiry-before-read-transaction** case, not a debated prior-read linearization ordering: the actual PostgreSQL GET has not started when revocation commits. The allowed positive 200 response occurs only before authority loss.

## Reproduce

```sh
TEST_DATABASE_URL=postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci \
  pnpm exec tsx --test --test-concurrency=1 apps/api/test/workspace-cookie-revocation-qa.integration.test.ts
```

Require full exact-head F1 CI: lint, Prettier, typecheck, real PG16 migrations and integration, worker, restore, web and Chromium. A fixture, formatter or type error is **not** security RED. Future combined #180/#179/main review must rerun this unchanged test. The regular `main.ts` does not mount this synthetic Workspace endpoint; no production exploit is claimed. No source, database schema, CI workflows, payment, live Telegram or deployment changes.

Refs [#165](https://github.com/tim8es/cookie/issues/165), [#175](https://github.com/tim8es/cookie/issues/175), [#113](https://github.com/tim8es/cookie/issues/113), [#179](https://github.com/tim8es/cookie/pull/179), [#180](https://github.com/tim8es/cookie/pull/180).

## Evidence refresh

This QA document update does not change the test source or assertions. The test-code SHA above is proven GREEN by [F1 run #43922036718](https://github.com/tim8es/cookie/actions/runs/43922036718), including the explicit integration line `Cookie bearer, expiry and Telegram unlink revoke protected Workspace reads before transaction` (PASS). Full F1 CI must also pass on the final documentation-only HEAD; do not infer that from the previous SHA. Keep this QA PR Draft and unmerged pending combined backend review and #165/#175 release gates.
