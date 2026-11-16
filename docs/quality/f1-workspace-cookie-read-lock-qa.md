# F1 QA: protected Workspace GET must hold session/link authority locks until COMMIT

**Status: PASS** — initial exact test-head SHA `620efbd594ad309178b4c9c4c41d7423935aeb92`, [full F1 CI #43927730725](https://github.com/tim8es/cookie/actions/runs/43927730725) **SUCCESS**: 103/103 unit, **62/62 real PostgreSQL 16 integration**, 46/46 web, lint/Prettier/typecheck, migration/backup/restore, compiled worker, API+Svelte build, Chromium browser smoke. The exact two-mode `Workspace HTTP read retains bearer/link authorization locks until its transaction commits` regression PASS (~905 ms). QA-only regression based on `main` SHA `a26807dbcc4bccb21c4ef7ffe68e20f140ce793d`. No backend, workflow, migration or production changes.

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

## Reproducibility

Only a QA documentation evidence update follows the proven test-code SHA above; the source, checkpoints and assertions are unchanged. The final documentation-only HEAD requires its own full CI success before marking that latest exact head green. The first CI was halted at Prettier before SQL and does not constitute a security regression; the test was formatted byte-for-byte using the repository's own pinned Prettier, and the temporary formatter diagnostic workflow was deleted from the final diff. Keep PR Draft, no main merge or production claims. The read-first case complements revoke-first QA #183 and does not decide strict role-read policy #175.

## Финальная сверка с main, 16 ноября 2026

Этот QA PR теперь основан на `main` `e931b70fa06762791093d691edb9cc4bc9fd6d90`: в нём объединены обе последовательности revoke-first Workspace #190 и положительные Cancel/Reschedule #188, браузерный Booking #152 и внутренний Identity retention #189. Сценарий **read-first** (GET сначала получает link/session FOR SHARE, затем отзыв должен ждать COMMIT, SQLSTATE `55P03`, после отзыва следующий GET = 401) сохранён без изменения исходного QA-кода. Прежний [CI #43928213397](https://github.com/tim8es/cookie/actions/runs/43928213397) зелёный на старой базе и не подтверждает эту композицию; данный документационный коммит запускает новый полный F1 CI. Строгая свежесть Role policy по #175 не принимается автоматически, production не включён.

## Post-#195 combined main revalidation

`main` now includes the independent post-409 refreshed availability QA #195, commit `3833803c554c4e4cd5593e215ed7bb12c494ea77`. This read-first Cookie/Telegram transactional lock QA test remains unchanged; the preceding full [F1 CI #43929951225](https://github.com/tim8es/cookie/actions/runs/43929951225) passed on main `e931b70f...`. This documentation-only update requests a new exact-head CI on the updated combined main before merge. No change to unapproved strict role-policy option #175 and no production activation.

## Latest-main read-first serialization check (2026-11-16)

Independent source test passed full [F1 CI #43929951225](https://github.com/tim8es/cookie/actions/runs/43929951225) on the previous main-based QA head `4ce719cca97c1b0d946c49fa7dd3228f06f12586`. The base is now explicitly refreshed to `main` commit `3833803c554c4e4cd5593e215ed7bb12c494ea77`, after unrelated Booking/CI and role-security merges. The test's authentic SQLSTATE 55P03 revoke-waits-for-protected-read oracle, positive authorized GET and post-COMMIT 401 assertions remain byte-for-byte unchanged. Require a **new exact-head, latest-main full F1 CI success** before merge. This test covers Cookie bearer and Telegram link row authority, **not** the contested RoleAssignment/Role snapshot linearization policy #175; no production/real PII/provider.
