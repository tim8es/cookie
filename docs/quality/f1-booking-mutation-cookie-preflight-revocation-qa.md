# F1 independent QA — Cookie revocation before Cancel/Reschedule HTTP mutation

**State: VERIFIED PASS** for test-code SHA `18704682f33bce61329e3fa095eedeee919e644b`, [full F1 Actions #43924688611](https://github.com/tim8es/cookie/actions/runs/43924688611): 103/103 unit, **59/59 real PostgreSQL 16 integrations**, 46/46 web checks, lint/Prettier/TS, migrations, backup/restore, worker, API/Svelte build and Chromium browser all PASS. Original strict Cancel and Reschedule assertions passed unchanged (385ms). Test-only branch based on `main` SHA `82dd319dbfbb7e23ad19513c3cf076486fb672e2`, which already includes merged [#173](https://github.com/tim8es/cookie/pull/173) and [#180](https://github.com/tim8es/cookie/pull/180). No backend production code or migrations modified.

## Threat and acceptance

A real PostgreSQL-backed Cookie bearer may pass HTTP authentication, but be revoked or expire **before** the protected business command starts. Both opt-in business mutations must then deny 403:
- `POST /v1/organizations/:tenantId/bookings/:bookingId/cancel`: exact bearer revoked after successful session verifier return.
- `POST /v1/organizations/:tenantId/bookings/:bookingId/reschedule`: exact bearer expires via a CHECK-preserving synthetic DB clock update after successful session verifier return.

No booking state/status/time may change and **no new command receipt, Outbox event, time-change audit or cancel audit** may persist after denied requests. Positive HTTP 200 Cancel and Reschedule controls must succeed with a valid real Cookie bearer first, to avoid a universal-deny false pass.

## Real PostgreSQL 16 test design

File: `apps/api/test/booking-mutation-cookie-revocation-qa.integration.test.ts`.

- Creates synthetic Organization, location, trusted server-side owner/role, Customer, catalog Service, Staff, shift and four nonoverlapping Confirmed Bookings with `createBookingInternal`.
- Creates synthetic **database-stored opaque Cookie bearer rows** with real SHA-256, issuer/audience and expires-at, then uses the actual `PostgresOpaqueTelegramSessions.verifyBearerToken`; no stub claims, no client-provided authority. The session is purposefully unlinked to Telegram; it tests the direct opaque bearer loss boundary only. Telegram consent/HMAC link exchange is verified separately in #183/#180.
- Runs real Fastify opt-in `syntheticBookingMutations`, not a production-registered route. One positive Cancel and one positive Reschedule must return 200 with correct status.
- Runs another pair of mutations and pauses **only the successful real session verification** using Promise barriers. An independent PostgreSQL transaction revokes/ages the specific bearer and the real provider must return `null` before the command resumes. Expect 403, unchanged exact Booking state and no new database side effects (snapshot before/after).
- Cleans up all synthetic tenant rows and connections. No arbitrary delay, network provider, real PII, payments, deployment or main merge.

## Reproduce and review

```sh
TEST_DATABASE_URL=postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci \
  pnpm exec tsx --test --test-concurrency=1 apps/api/test/booking-mutation-cookie-revocation-qa.integration.test.ts
```

Mandatory: lint, Prettier, TS, unit, all PostgreSQL migrations and integrations, backup/restore, worker, API/web build and browser smoke on exact PR HEAD. If fixture/format/compilation fails, **do not label a security defect**; correct the test only. Source route is explicitly opt-in and disabled in production `main.ts`; test cannot establish a live exploit. [#113](https://github.com/tim8es/cookie/issues/113), [#165](https://github.com/tim8es/cookie/issues/165), [#144](https://github.com/tim8es/cookie/issues/144) remain release review gates.

## Final evidence note

This **documentation-only** evidence update intentionally leaves the test source unchanged. The test-code head above is green; the final docs-only commit must separately complete exact-head full CI before a final green status is claimed. The first run was stopped at Prettier before PostgreSQL and therefore was **not** security RED; pinned formatting was corrected and the temporary formatting workflow was deleted. The new test deliberately isolates direct Cookie bearer authority and must not be mistaken for a real Telegram-link or public production API test. Keep PR Draft until independent review and latest-main reconciliation.

## Current-main CI revalidation (2026-11-16)

The independent test originally passed [full CI #43925220385](https://github.com/tim8es/cookie/actions/runs/43925220385) against earlier `main` including canonical Cookie bearer #173. The PR base has now been refreshed to commit `53de65ae8e7b833e1fc7ff756943c78430ca216e`, which also contains bounded worker #166 and hardened F1 CI #139. This documentation-only update forces a full exact-head run on that combined tree; test assertions, endpoints and synthetic fixtures are **unchanged**. Do not merge on the older green run. No production deployment or real customer/Telegram data.

## Integration base advanced during review

After the full green SHA `91c4bde807d05713fda99b2c0be72243d8e23822`, `main` advanced again from `58fc6a9eef14a052578b7fdf66478b7f4f30f316` to `53de65ae8e7b833e1fc7ff756943c78430ca216e` with Outbox worker and CI workflow consolidation. Re-run the **unchanged QA source** against this base, including any newly mandatory worker/visual CI gates, before claiming a current-main green. Prior check remains valid only for its recorded merge-ref.
