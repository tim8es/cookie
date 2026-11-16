# F1 independent browser QA — assert real Booking HTTP response status

**Scope:** test-only reinforcement of synthetic Chromium Svelte BookingForm → HTTP → PostgreSQL 16 gates in stacked PR #135. No app/Svelte code, product API, migration, CI workflow or provider is changed.

## Missing assertion in parent QA gate

PR #135 records browser `Network.responseReceived` events as diagnostics but asserts only displayed Svelte error text, request count and persisted PostgreSQL rows. Those assertions do not directly prove the actual browser-originated HTTP status claimed in the PR title.

## Additional assertions

The CDP driver correlates `Network.requestWillBeSent.requestId` for the Booking POST with `Network.responseReceived.requestId`. The exact observed HTTP status list is asserted for each end-to-end browser scenario:

- **Confirmed**: exactly one Booking POST, HTTP **201** and server receipt in UI/DB.
- **Stale slot**: exactly one Booking POST, HTTP **409**; no Confirmed UI/receipt/outbox duplicate.
- **Revoked membership**: exactly one Booking POST, HTTP **403**; denied UI and no unauthorized DB mutation.

Both negative UI paths retain the same 375×812 mobile horizontal-overflow assertion as the original happy path. Neither the HTTP status nor error text is injected by the test driver; events are captured from the real Chromium network.

## Execution and limitations

- Stacked base: [PR #135](https://github.com/tim8es/cookie/pull/135) head `5155e09cfaf4495e35d1813115a53b016bf37d2d`.
- Test source `scripts/f1-browser-cdp.mjs` is used from existing `apps/api/test/booking-http.integration.test.ts`.
- Real PostgreSQL integration command: `pnpm test:integration` with `TEST_DATABASE_URL`, Chromium, and existing Vite test fixture.
- Full `.github/workflows/f1-ci.yml` must PASS on exact QA head before this stacked PR can be approved. No standalone fake PASS.
- The tested bearer and localhost are synthetic; this is **not** production Cookie AuthN, public Booking API deployment, a real Telegram Mini App or a complete F1/pilot readiness proof.

Related #23, #66, #113.

## Latest-main test-only consolidation (2026-11-16)

This final QA leaf now targets `main` `53de65ae8e7b833e1fc7ff756943c78430ca216e` and carries BOTH independent Chromium tests from #135 (stale-slot 409 and revoked-role 403, retaining 201 Confirmed positive control) and #152 (assert actual correlated HTTP 201/409/403 Network responses, not only UI text). No production source/API/SQL/CI workflow is changed. Previous [CI #43896682467](https://github.com/tim8es/cookie/actions/runs/43896682467) tested the older stacked branch; a new full F1 CI on the updated main-based PR is mandatory before merge. Chrome DevTools startup intermittency is tracked separately as #164 and must never be hidden by weakening these HTTP/DB assertions.

## Current-main final F1 gate (2026-11-16)

This QA branch now targets `main` commit `ff31b9e1c0b0717ee90fe7b5b617d616de27b24b`, including Cookie revoke-first Booking/Workspace QA, bounded worker and hardened CI. It consolidates the original #135 UI stale-slot (HTTP 409) and Membership revocation (HTTP 403) cases with explicit DevTools **real network POST** 201/409/403 response-code evidence. Previous successful #152 CI [#43926353865](https://github.com/tim8es/cookie/actions/runs/43926353865) ran on an older base, so this documentation-only commit triggers an exact new F1 workflow before any merge. No browser or DB regression assertions are altered, no new public route, provider, real customer data or production deploy.
