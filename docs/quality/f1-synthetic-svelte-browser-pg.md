# F1 test-only Svelte BookingForm → browser HTTP → PostgreSQL acceptance slice

**Status: PROPOSED / synthetic CI only. Not a user-facing F1 launch, live client API or approved auth.**

## Why

Previous green [#121](https://github.com/tim8es/cookie/pull/121) and canonical review [#124](https://github.com/tim8es/cookie/pull/124) validated a frontend TypeScript booking adapter against real local Fastify/PostgreSQL, and separately validated the demo UI via Chromium. They did **not** prove a browser click on an actual Svelte component could result in a durable Booking.

## Harness boundaries

This Draft PR is based on **current `main` after canonical [#125](https://github.com/tim8es/cookie/pull/125), QA [#126](https://github.com/tim8es/cookie/pull/126), typed import fix [#128](https://github.com/tim8es/cookie/pull/128) and mock booking UX [#129](https://github.com/tim8es/cookie/pull/129)**. It ports the previously CI-green browser fixture from standalone [#127](https://github.com/tim8es/cookie/pull/127) without replacing any updated main API tests/imports. It adds a **separate test-only Vite root** under `tests/f1-browser/`, using existing `apps/web/src/lib/ui/BookingForm.svelte`, `BookingAttemptStatus.svelte`, frontend `BookingAttempt` and `createProposedF1SyntheticLoopbackClient`; no shipping `App.svelte`, `api.ts`, frontend import graph, build entrypoint or `apps/web/**` source is modified.

The synthetic PostgreSQL integration creates an additional UTC shift, starts the existing injected test-only Fastify application bound to ephemeral `127.0.0.1`, and starts a separate Vite *development-only* browser fixture bound to another ephemeral loopback port. Vite proxies only `/v1` requests to the local Fastify listener; the page's API calls remain same-origin.

`scripts/f1-browser-cdp.mjs` uses the existing system Chromium binary and CDP to simulate a **real user click** on a slot and the Svelte form's actual submit button at a 375×812 CSS viewport. The Svelte handler invokes the existing frontend #119 request adapter, not a fake API response. Browser asserts a **verified Confirmed** receipt, the returned Booking UUID, the server-committed price and UTC time. The PostgreSQL test independently asserts the exact corresponding Booking and one receipt/Outbox event, not merely browser text.

## Guardrails and limitations

- Form fields are synthetic and local. The browser test passes a synthetic owner bearer token via its localhost test-only fixture URL. This is **never** a safe way to deliver production tokens; normal production startup injects no verifier and Svelte's regular `api` mode continues to fail closed.
- The borrowed `BookingForm` retains DEMO copy and preview price; this isolated harness is explicitly marked as a database-writing *test fixture* in its own header. Do not mistake the fixture for a live customer reservation page or expose it as a public route.
- All HTTP requests to booking backend are via Vite's local same-origin `/v1` proxy and local Fastify. No remote origins, real PII, payments, SMS, Telegram, OAuth or external systems.
- This is **real Svelte component → browser fetch → local HTTP → PG**, but **not the shipping `App.svelte` flow** and not full F1 acceptance #23. It is a technical integration test of UI components/adapter composition.
- No true lost PostgreSQL COMMIT acknowledgment/TCP fault injection, production AuthN, customer ownership, entitlements, cancellation deadlines, F2 quote/promotions or mobile physical-device testing.
- CI lint, typecheck, PostgreSQL 16 integration, browser actions, ordinary Svelte build and existing mock browser smoke must all pass. PR stays Draft; no merge or deployment without explicit owner review.
