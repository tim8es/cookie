# F1 synthetic Chromium negative booking states — conflict and revocation

**Status: PROPOSED test-only security/UX gate; no public Booking integration or product acceptance.**

## Provenance

Based on current `main` after merged #125 (canonical synthetic frontend+backend), #126 (PG security QA), #128 (typed frontend adapter integration), #129 (demo cancel/reschedule), #131 (provisional Quote) and #134 (Chromium Svelte BookingForm → Fastify → PG16). Uses the existing test-only Vite/Chromium harness from #134 and **only extends test driver and one PostgreSQL integration test**.

## Real browser paths under PostgreSQL

1. **Confirmed baseline:** existing 375×812 Chromium test selects the real server's 10:00 slot, clicks the existing Svelte `BookingForm`, and proves a confirmed server receipt, authoritative price and one durable booking/receipt/outbox.
2. **Stale availability and 409:** a fresh browser renders 12:00 availability, then a synthetic second authorized actor **actually commits** the 12:00 booking before the user clicks Submit. The real browser POST must get HTTP 409. The actual Svelte `BookingAttemptStatus` must display **"Выбранное время больше недоступно"**, show newly refreshed server slots, and never display a Confirmed receipt or automatically retry. PostgreSQL must contain **only the competitor's Booking, receipt and Outbox**, with no duplicate from the conflicting browser submit.
3. **Revocation and 403:** a fresh browser renders 14:00 availability, then a second PostgreSQL connection **commits Membership.active=false** for the synthetic owner before the browser submits. The real browser POST must get 403; the actual Svelte status must display **"Операция недоступна"** without Confirmed, and PostgreSQL booking/receipt/outbox counts must remain unchanged.

A single `runF1BrowserBooking` driver drives all three modes with injected **test-only** callbacks at the stable boundary *after server availability was rendered, before Submit*. Existing test-only CDP bearer injection remains; the synthetic bearer never appears in URLs. All page requests must stay on `127.0.0.1`, with zero uncaught page exceptions; no change to `apps/web/**` or normal API bootstrap.

## Limitations and release gates

- Synthetic staff-assisted Booking, synthetic permissions and test database only. Real public customer authentication, client↔Booking ownership, commercial entitlement and production web app API mode remain unavailable.
- The test proves browser-level **sequential stale-state/revocation behavior**, not all possible concurrent database interleavings; separate #113 PostgreSQL row-lock race tests still own those claims.
- No real notifications, payments, Telegram login, PII, or deployment.
- CI lint, format, TypeScript, unit, PostgreSQL 16 integration, backup/restore, Svelte build and existing mock browser smoke must pass on exact PR head.
- The PR is a Draft security regression; **no merge without owner approval**. Keep Issues #23, #66 and #113 open until their broader release gates are met.
