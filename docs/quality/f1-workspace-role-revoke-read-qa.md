# F1 independent QA — protected workspace role revocation race

## Status and target

**Unverified pending real PostgreSQL 16 CI.** QA-only branch stacked on backend [PR #173](https://github.com/tim8es/cookie/pull/173), exact parent SHA `48e8ba8b59b85eb8cb31d7b8d0e8cc4dbd4455f2`. This test concerns **policy authorization for a protected workspace read**, not the session/link revocation already covered by [#165](https://github.com/tim8es/cookie/issues/165), nor the membership/session lock-order regression in [#174](https://github.com/tim8es/cookie/pull/174).

## Invariant

When a Role with the only `booking.read` grant is deactivated and that PostgreSQL revocation **COMMITs before the protected GET's permission decision**, the GET must return HTTP 403 and must not expose the organization name or location details. An alternative valid ordering is for the protected read to hold a relevant `FOR SHARE` policy row lock through its transaction COMMIT; then the revocation cannot commit first and the read may return 200.

## Deterministic test

- File: `apps/api/test/workspace-role-revoke-read-qa.integration.test.ts`.
- A fresh synthetic tenant, Identity, active Membership, Owner Role, RoleAssignment, location and exact stored Cookie opaque bearer are created in real PostgreSQL. The real `PostgresOpaqueTelegramSessions.verifyBearerToken` verifies the bearer; synthetic fixture has no Telegram link.
- The real opt-in `GET /v1/organizations/:tenantId/workspace-context` is mounted via `createApp`; it is **not** mounted by production `main.ts`.
- A test-only wrapped `PoolClient.query` runs the real policy SQL, then holds its **completed** policy SELECT response before the HTTP adapter can evaluate it. No SQL or business source is mocked.
- An independent PG transaction sets `roles.active=false`, with `lock_timeout='250ms'`. If it COMMITs first, response must be 403 and must omit protected metadata. If a policy lock prevents the commit (`55P03`), the read can finish first and return 200, followed by a sequential revoke that must make the next read return 403.
- Verify session itself remains valid after role revocation, to isolate Role-based authorization. Release the barrier and clean up the synthetic rows in `finally`. No schedule-based interleaving or arbitrary sleep.

## Reproduce

```sh
TEST_DATABASE_URL=postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci pnpm exec tsx --test --test-concurrency=1 apps/api/test/workspace-role-revoke-read-qa.integration.test.ts
```

Review the **exact-head** F1 Actions run before treating this as GREEN or RED. A failure in formatting, TypeScript, test fixtures or PostgreSQL setup is not evidence of a security bug. The current source review suggests `workspace-http.ts` reads `loadPolicySnapshot` without the `lockPolicyRows` used by `requireTenantPermission`; this is **a hypothesis until the real PG interleaving runs**.

No production code, migrations, CI or any other agent's branches were changed. No real Telegram user, PII, external provider, payments or deployment. Related [#113](https://github.com/tim8es/cookie/issues/113), [#165](https://github.com/tim8es/cookie/issues/165), [#173](https://github.com/tim8es/cookie/pull/173).
