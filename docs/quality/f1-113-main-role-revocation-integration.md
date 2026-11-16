# F1 #113 — independent role-revocation regression integration

This branch is an isolated **QA-only** current-main integration for independent PRs #136 and #140; base main SHA `82dd319dbfbb7e23ad19513c3cf076486fb672e2` (already includes #173 P0 opaque Cookie AuthN guard and #159 bounded Outbox).

## Test provenance and scope

- [QA #136](https://github.com/tim8es/cookie/pull/136): `policy-multi-role-tenant-revocation-qa.integration.test.ts` copied **byte-for-byte**, blob `e3ff09730bf7c74c0ae7bd1768a38dd400201031`. Two granting roles in tenant A, another grant in tenant B; revoke of relevant roles must serialize against a protected policy transaction, while unrelated tenant B can make progress; removing only one of two grants must not incorrectly deny A, removing both must.
- [QA #140](https://github.com/tim8es/cookie/pull/140): exact extended `booking-revocation-race-qa.integration.test.ts` blob `656f86ece619b87ed321f3c292c618de3331e3a6` copied over existing test without weakening original Create/Reschedule/Cancel assertions. Adds deterministic role `permissions` array removal while Booking is in-flight; revocation-first requires ACCESS_DENIED/no mutation, command-first may finish only if revoker cannot commit first. Original test existed on main.
- Their original QA documentation copied byte-for-byte with historical exact-head evidence and limitations.

## Acceptance

Require a new exact-head **full** F1 workflow with real PostgreSQL16 before claiming either imported regression PASS on this base: lint, formatting, boundaries, TypeScript, unit, integration, migrations, backup/restore, worker and Svelte/Chromium browser gates. If a fixture fails after migrations or Identity integration, fix test-only data setup without weakening assertions and record old/new source SHA and test outcome.

No runtime/API/schema/frontend/provider changes in this PR, no real PII, pilot, or production rollout. #113 remains release-gating pending cross-surface policy and customer ownership verification. Source tests are policy/Booking command-layer, not proof of actual public AuthN, permission-revocation delivery or all PostgreSQL deadlock schedules.

Keep historical red/green QA evidence on #136/#140; close them as **superseded only after** merged QA goes into main.
