# F1 independent QA — protected workspace role revocation race

## Status and target

**Confirmed RED against proposed strict Workspace read freshness contract** — [full F1 CI #43918414828](https://github.com/tim8es/cookie/actions/runs/43918414828) on test head `2fbad83301623cb73bc1a4878361664a30a4a675`. Lint, Prettier, module boundaries, TypeScript, unit PASS; **46/47 real PostgreSQL integrations PASS, 1 target assertion FAIL** at test line 174: `HTTP 200 !== expected 403`. Build/browser did not run after the PostgreSQL gate failed. QA-only branch stacked on backend [PR #173](https://github.com/tim8es/cookie/pull/173), exact parent SHA `48e8ba8b59b85eb8cb31d7b8d0e8cc4dbd4455f2`. This test concerns **policy authorization for a protected workspace read**, not the session/link revocation already covered by [#165](https://github.com/tim8es/cookie/issues/165), nor the membership/session lock-order regression in [#174](https://github.com/tim8es/cookie/pull/174).

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

## Result and policy classification

The independent Role deactivation UPDATE committed **after** the actual policy SQL SELECT returned but **before** the HTTP adapter consumed the held result and completed its decision. The GET returned 200. This proves the current adapter does not synchronize protected Workspace policy snapshots through the end of the read transaction. Session validity itself was real and unchanged; this is not a Cookie session revocation test.

**Important ambiguity:** The SQL policy snapshot was read before revocation committed. If the product chooses a *read-first* linearization point at the successful policy SELECT, then an overlapping revoke is permitted to commit before the HTTP response without invalidating that in-flight read. The RED is therefore against an intentionally **stricter proposed consistency contract**, not sufficient alone to establish an unauthorized production information disclosure or a release-blocking vulnerability. [Issue #175](https://github.com/tim8es/cookie/issues/175) requires the owner to select and document the contract. For strict semantics, acquire Membership/RoleAssignment/Role authority locks before the Session lock and retain them through transaction COMMIT. For snapshot/read-first semantics, assert a read that **begins after revoke COMMIT** denies, and specify UI capability-cache invalidation. Do not mark either policy as approved by a red test alone.

The prior diagnostic CI failed on formatting before integration, so its outcome is **not** cited as a security result. The temporary formatter workflow was deleted. Backend PR #173 advanced independently during this test; the QA branch does not change backend production source or another agent's test file.

No production code, migrations, CI or any other agent's branches were changed. No real Telegram user, PII, external provider, payments or deployment. Related [#113](https://github.com/tim8es/cookie/issues/113), [#165](https://github.com/tim8es/cookie/issues/165), [#173](https://github.com/tim8es/cookie/pull/173).

## Proposed strict-consistency implementation comparison (2026-11-16)

The independent QA test above remains source-identical (original blob `342302318473e08746676cd9c475c1944856d7e1`). Candidate [PR #179](https://github.com/tim8es/cookie/pull/179) copies that unchanged test and adds transaction-held Policy/Membership/Role row locks before Cookie link/session revalidation. Its exact-head [F1 CI #43919139176](https://github.com/tim8es/cookie/actions/runs/43919139176) completed **SUCCESS**, including 47/47 real PostgreSQL 16 tests, 101/101 unit and 46/46 web checks. The previously RED role revocation assertion is GREEN in that source-fix branch.

This QA PR was retargeted to #179 only to obtain a *separate QA-branch* integrated CI. **Issue #175 remains OPEN:** the owner has not yet selected strict transaction-scoped read linearization versus snapshot/read-first semantics. A green strict implementation is engineering evidence, not acceptance of a contested product contract. Do not merge #179 or mark #175 closed without the contract decision, current-main integration and frontend capability-cache review. No production deploy.
