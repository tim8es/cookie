# Cookie — design iteration 06: visible lookup failure and controlled retry

**Date:** 2026-11-16 · **Status:** PROPOSED, synthetic browser evidence only  
**Stack:** #158 → #163 → #169 → #184 → #192 → this iteration.

## Context

Iteration 05 separated `slotLoadError` from genuine zero-slot results in the customer booking screen, but the prior browser test only proved the successful Sunday → Monday path. Thus the failure/Retry UI was **implemented but not independently exercised**. This is an evidence gap, not a claim about a real provider outage.

The production/API path is deliberately fail-closed until trusted Booking API contracts. The only repeatable, authorized test surface is synthetic `MockCookieApi` with `sessionStorage` and the Chromium `?browser-smoke` fixture.

## Scope of this PR

- Add a strictly **mock-and-browser-smoke-only** one-shot failure key `cookie.frontend-demo.smoke.fail-next-slots`. The adapter checks it only if `window.location.search` contains `browser-smoke`, removes the key before throwing `SYNTHETIC_SMOKE_SLOT_LOOKUP_FAILED`, and otherwise uses unchanged fixture logic. It does not mutate catalog, business data or bookings; it is not a server endpoint or external fetch.
- In the existing Chromium journey, after a successful Sunday-empty → Monday-available recovery, set the one-shot key, change the day, assert a customer-friendly `role=alert` message, retry affordance, no slot buttons, disabled Create, no raw technical exception in visible text, and flag consumption.
- Click `Повторить проверку`, recheck the same selected date, assert restored slots, absence of error, no automatically chosen time, and Create still disabled.
- Capture **20-slot-lookup-error** and **21-retry-restored** screenshots for 1280×800, 375×812 and 320×568; enforce widths and labels.
- No new backend/Identity/Price/UI navigation changes. No imports or writes to production paths beyond the isolated test-only mock behavior.

## Acceptance and boundaries

1. **Failed read ≠ no availability.** Guest sees "Не удалось проверить время" with Retry; zero-slot copy is absent.
2. **No optimistic success.** No slot rendered on error, and no booking submit until a time is chosen after retry.
3. **Recoverability.** Retry is another normal `loadSlots` call with the original date/staff/location, and shows fixture slots again without a reload.
4. **Privacy and integrity.** Synthetic failure detail is not visible to the customer. No external requests. Test key is consumed once and ignored outside the explicit browser-smoke URL.
5. **CI:** exact PR-head lint/format/types/unit/PG integration/Svelte build/Chromium PASS and actual screenshots reviewed.
6. **Limitations:** no real HTTP outage, offline PWA, network latency, Telegram WebView, screen-reader device, server 409/403, auth or reservation correctness is proven. Those require their own real API/role acceptance.

## Future integration

Before real client launch replace the local adapter with trusted API responses and map transport errors to defined UI states. Verify 409 stale availability, 401/403 revoked identity, retry policy, current server Quote and confirmed Booking semantics with real end-to-end evidence. Keep raw HTTP/SQL details out of customer-facing text.

**References:** [ADR-0005](../architecture/ADR-0005-shared-booking-ui.md), [iteration 05](booking-slot-recovery-iteration-05.md), [F1 acceptance cases](../quality/f1-pilot-acceptance-cases.md), issues #13/#23.
