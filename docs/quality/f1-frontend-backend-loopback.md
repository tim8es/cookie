# F1 synthetic frontend adapter → Fastify HTTP → PostgreSQL compatibility gate

**Status: PROPOSED; isolated synthetic integration for review, not a public customer E2E or production readiness claim.**

## Provenance and composition

- Base: frontend [Draft #119](https://github.com/tim8es/cookie/pull/119), including [#115](https://github.com/tim8es/cookie/pull/115), [#111](https://github.com/tim8es/cookie/pull/111), and the earlier frontend UX/API stack.
- Exact backend file overlay: all **17 changed backend files** relative to `main` at [Draft #118](https://github.com/tim8es/cookie/pull/118), commit `5817066c31a490347542cd1190343004c08284db`. All 17 Git blob SHAs were reused unchanged in a single integration-only commit.
- This branch **does not modify a single `apps/web/**` path** relative to #119 and does not enable any production/browser-facing API wiring.

## What is actually exercised

In `apps/api/test/booking-http.integration.test.ts`, the existing synthetic PostgreSQL 16 fixture starts a local-only Fastify listener on ephemeral `127.0.0.1:0`. A new test section imports **the actual frontend #119** `createProposedF1SyntheticLoopbackClient` and `BookingAttempt` state machine (not a copied/stubbed implementation), and passes Node `fetch` to those modules.

1. Frontend client calls the server's actual availability endpoint and decodes the current server base price and available UTC slot.
2. The synthetic test updates the Service base price between the read and create operations. Frontend request sends **no price**; backend CreateBooking reads authoritative current price inside its database transaction.
3. A wrapper around real `fetch` first sends the CreateBooking request and obtains HTTP 201, then **discards the response and throws** to emulate a client not receiving a success reply. BookingAttempt stays in an uncertain retryable state and refuses a fresh-key reset.
4. An explicit retry with the **same Idempotency-Key** obtains the durable original Confirmed receipt. The frontend validator accepts a real booking UUID and displays the actual committed server price, not the preliminary availability price.
5. A second attempt on the occupied slot receives an actual backend HTTP 409 with `BOOKING_CONFLICT` and refreshes actual availability. An outsider token receives HTTP 403 and cannot become Confirmed.
6. PostgreSQL assertions verify the single additional booking, receipt, Outbox and committed price, in addition to existing booking concurrency/revocation/policy tests.

## Strict safety / release gates

- The temporary local listener and synthetic bearer verifier are **only installed inside the integration test**. Normal `apps/api/src/main.ts` still exposes no synthetic Booking routes. `apps/web/src/App.svelte` and `api.ts` do **not** call the synthetic client.
- This is **adapter → network → database**, **not** an actual Chromium browser click through Svelte, a real phone/mobile session, Telegram Mini App, or an external customer booking.
- The deliberate response discard happens after receiving an HTTP 201 at the test wrapper, **not** at a real TCP reset/unknown PostgreSQL COMMIT boundary. Do not claim transport fault injection or production recovery is proven.
- The identity and Customer fixture are synthetic. There is no production AuthN, customer ownership binding, trial/paid entitlement, F2 price resolver/promotions, cancellation deadlines, live notifications or deployment.
- PR #118's `FOR SHARE` policy revocation fix is present only in this **composition**; security issue #113 and original security PRs remain under independent review.
- At consolidation choose a canonical source for the backend security/API patches and the frontend adapter; this test branch is not a license to merge duplicate stacked changes.
- Required acceptance: exact-head GitHub CI green for lint, formatting, TypeScript, unit, PostgreSQL integration, backup restore, API build, worker smoke and Svelte frontend check/build; browser smoke still tests mock UI separately.
