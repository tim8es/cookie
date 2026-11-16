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
