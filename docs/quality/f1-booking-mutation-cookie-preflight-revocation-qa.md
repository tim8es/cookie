# F1 independent QA — Cookie revocation before Cancel/Reschedule HTTP mutation

**State: UNVERIFIED until full exact-head PostgreSQL CI.** Test-only branch based on `main` SHA `82dd319dbfbb7e23ad19513c3cf076486fb672e2`, which already includes merged [#173](https://github.com/tim8es/cookie/pull/173) and [#180](https://github.com/tim8es/cookie/pull/180). No backend production code or migrations modified.

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
