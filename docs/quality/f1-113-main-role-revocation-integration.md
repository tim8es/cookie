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

## Independent initial CI evidence and moving-base revalidation

The first exact-head F1 [run #43923813962](https://github.com/tim8es/cookie/actions/runs/43923813962) completed **SUCCESS** for QA commit `18bc2a84491927d5970cd9f3b98865b1502cb1b7` against then-current `main` `82dd319dbfbb7e23ad19513c3cf076486fb672e2`. The two imported role/tenant QA tests were not modified.

While this run executed, #161 merged a separate bounded alert-delivery maintenance change and `main` advanced to `58fc6a9eef14a052578b7fdf66478b7f4f30f316`. The present documentation-only commit intentionally triggers another full PR CI on the newer merge-base before merging into main. The earlier green run must not be reused as verification of the newer base. No production deployment.

## Current main integration rerun

[F1 CI #43924327926](https://github.com/tim8es/cookie/actions/runs/43924327926) passed the exact prior QA source (head `03a6a55add6dd1c5bf149b5d5144f6c7434de8ae`) on the then-current main. Since that run, the tested main has advanced to `f9df29a2f7c5865da6814c6f6a0423fe47b85569` after #166 worker integration. This documentation-only commit triggers a fresh PR merge-base CI. The imported test assertions remain unchanged; do not treat previous green CI as proof of the new combined state. No deployment.
