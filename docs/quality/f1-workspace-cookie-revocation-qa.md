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

## Independent latest-main extraction (2026-11-16)

The original #183 source test is preserved **byte-for-byte** (Git blob `e8ae9fede2087a587084f902295d59571b6ac544`) in this new clean branch from `main` `53de65ae8e7b833e1fc7ff756943c78430ca216e`. The old #183 branch inherited #179's **unapproved strict role-read implementation**, which conflicts with current main and with the unresolved policy choice #175. Only this bearer/session/link revoke-before protected Workspace GET test and its evidence document are moved; no role-read implementation or synthetic API behavior changes. Previous green CI #43922612156 was on the older #179 stack and is not PASS evidence for this clean main extraction. Run exact-head full F1 CI again before merge; no production deployment or PII.

## Main merge-base revalidation after role QA #187

Role permission and tenant isolation QA [#187](https://github.com/tim8es/cookie/pull/187) was merged independently into `main` `a26807dbcc4bccb21c4ef7ffe68e20f140ce793d`. This protected Workspace Cookie revoke-first test remains source byte-identical to original #183; only its PR base and this evidence note changed. Run full F1 CI at the new exact head before merge; earlier passing CI from #183's strict Workspace branch is not sufficient. No #175 decision was made by this extraction.

## Final current-main security composition (2026-11-16)

QA #188 was merged into main as `9279bb29e128f01c0b604998e07825bd3db96f4b`, adding positive and revoke-first Cancel/Reschedule cases. This Workspace read QA PR is explicitly retargeted to that commit for an exact-head full GitHub F1 CI run; only this note changed, original protected Workspace three-mode test still has blob `e8ae9fede2087a587084f902295d59571b6ac544`. No application source or unresolved #175 Workspace role-policy contract is changed. No public API/deployment.
