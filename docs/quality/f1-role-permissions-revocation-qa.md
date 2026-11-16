# F1 QA — concurrent role permission removal during Booking

**Status: NOT RUN on this branch until exact-head CI completes.** Independent security regression only; no claim that Issue #113 is closed or that production is ready.

## Risk and invariant

Issue #113 originally reproduced Create/Reschedule/Cancel succeeding after independently committed Membership/Role/RoleAssignment deactivation. A separate permission-revocation path changes the `roles.permissions` array to remove a grant **without** changing `roles.active`. A previously authorized Booking command must not commit **after** that removal has independently committed.

The authorized operation is stopped at the existing deterministic domain-policy callback **after** its authorization read and **before** its business mutation. An independent PostgreSQL connection attempts `UPDATE cookie_identity.roles SET permissions=ARRAY[]::text[]` under a short transaction-local `lock_timeout`.

Both valid linearizations are accepted:
- The policy transaction retains a PostgreSQL row lock; the revoke receives SQLSTATE `55P03`, the Booking command finishes first, and the revoke is applied afterwards.
- The revoke commits first; the Booking command must reject with `ACCESS_DENIED` and commit no unauthorized mutation.

The existing test asserts that no race is both `revokeCommittedFirst` and `fulfilled`. The new case is included in the same assertion alongside Create/Membership, Reschedule/Role active and Cancel/RoleAssignment active. All identifiers and data are synthetic.

## Test execution

- Base `main` SHA: `01f7d6ac06af0d58ff14f32ca310234d3fb7576f`.
- Regression path: `apps/api/test/booking-revocation-race-qa.integration.test.ts`.
- Requires local/CI PostgreSQL 16 and `TEST_DATABASE_URL`.
- Exact focused command: `pnpm exec tsx --test --test-concurrency=1 apps/api/test/booking-revocation-race-qa.integration.test.ts`.
- Required full gate: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm test:integration` plus the other existing `f1-ci.yml` steps.

## Release boundaries and noncoverage

- This is a test of an **internal trusted-actor command**, not public login, production HTTP AuthN, a real browser session or Telegram webhook.
- Cross-tenant and multiple-grant policy-layer coverage is proposed separately in PR #136.
- The exact-head browser 409/403 test is proposed in PR #135.
- Worker compiled startup is proposed in PR #138.
- #113 remains a P0 security release blocker until the full documented release criteria and independently reviewed evidence are satisfied.
- No production source, schema, CI workflow, external provider, real PII, payment or deployment changed.
