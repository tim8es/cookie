# F1 QA: protected Workspace GET must hold session/link authority locks until COMMIT

**Status: PENDING real PostgreSQL 16 CI.** QA-only regression based on `main` SHA `a26807dbcc4bccb21c4ef7ffe68e20f140ce793d`. No backend, workflow, migration or production changes.

## Distinct risk / contract

Prior [PR #183](https://github.com/tim8es/cookie/pull/183) already proves the **revoke-first** order: revoke exact Cookie bearer, expire session or unlink Telegram *before* protected Workspace read starts, then stale verified preflight must be denied without disclosing organization/location metadata.

This independent regression checks the opposite **read-first** order on the actual `main` implementation, even without strict role locking proposed in #179: a protected Workspace GET has acquired the authentic PostgreSQL Cookie session + Telegram link `FOR SHARE` locks, but has not yet read metadata or committed. Concurrent revocation of either exact bearer or linked Telegram identity must **not be able to COMMIT first**. A 200 response is acceptable when the read owns the locks first and commits before the revoke; afterwards the revoke must commit and subsequent GETs must return 401. This avoids labeling a serialized prior-read response as a data leak.

## Deterministic PostgreSQL / HTTP evidence

- Synthetic Organization, Location, active owner Membership with scoped `booking.read`, consent/proof-confirmed Telegram link, and database-stored opaque Cookie bearer with server SHA-256 + fixed issuer/audience.
- Real `PostgresOpaqueTelegramSessions.verifyBearerToken`, opt-in `createApp` Workspace HTTP GET, and a **positive 200** metadata control.
- Test-owned transaction client proxy pauses the specific `SELECT display_name FROM cookie_tenancy.organizations` before execution, which only occurs **after** `assertActiveOpaqueSession` has acquired the real link/session row locks.
- Independent PostgreSQL connection attempts `UPDATE revoked_at` under `SET LOCAL lock_timeout='350ms'`; require SQLSTATE `55P03` and ROLLBACK (not a timed sleep or an unproven race). The pending read then returns 200 with its previously authorized organization/location.
- After GET COMMIT, apply the same revocation without a timeout; require successful update, actual provider verifier returns null, and next GET is 401 **without metadata**.
- Repeat independently for exact Cookie bearer revoke and trusted Telegram link unlink. Tenant fixtures and connections cleaned after checks.

No real Telegram messages or personal data, provider, public production API, deployment or payment. This proves a *specific serialization invariant*, not every possible PostgreSQL deadlock order, role policy race (#175), overall #113 or production readiness.

## Verification

```sh
TEST_DATABASE_URL=postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci \
  pnpm exec tsx --test --test-concurrency=1 apps/api/test/workspace-cookie-read-lock-qa.integration.test.ts
```

Run full F1 CI on exact PR HEAD with lint, format, typecheck, unit, real PostgreSQL migrations/integration, backup/restore, worker, API+Svelte build and Chromium browser smoke. If formatting or fixtures fail before the asserted lock timeout, this is a *test defect*, not evidence of a security regression. Keep Draft until independent security review / #165 / #113 / #144 main merge policies.
