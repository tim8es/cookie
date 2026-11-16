# F1 Booking conflict: real refreshed availability after HTTP 409

## Independent review gap

The merged Chromium Booking QA chain [#135](https://github.com/tim8es/cookie/pull/135) → [#152](https://github.com/tim8es/cookie/pull/152) proves on-wire 201, 409, 403 and expected Svelte feedback. However its 409 case only checked that **some** renewed-slot buttons existed. A stale option list containing the just-booked `12:00` could still pass, even though the competing Booking had already committed.

## Added test-only oracle

`scripts/f1-browser-cdp.mjs` retains all existing independent checks and additionally:

1. Counts actual browser `GET /availability` network requests in CDP after the browser has rendered the initial server slot.
2. Takes a baseline immediately before submitting the now-conflicted booking.
3. After the real Booking `POST` returns HTTP 409 and the Svelte conflict UI resolves, requires an additional availability GET and at least one offered refreshed slot.
4. Requires the previously selected and now-committed conflicting slot to be **absent** from `.booking-attempt-slot-options button` choices.

The same deterministic `beforeSubmit` PostgreSQL competitor interleaving, 409 status, no auto-retry, 403 membership revocation, 201 positive receipt and DB count assertions remain unchanged. This closes a false-positive acceptance gap; it is not distinct-principal concurrency testing (the fixture uses the same synthetic owner/customer). No server source, UI source, migrations, workflow or normal production API mount modified.

## Verification

Based on main `7819e9a7732d59e2de12a5dfcf51284865a604ca` (merged #152) and must pass **new exact-head full F1 CI**: lint/format, TypeScript, unit, PostgreSQL 16 integration including Chromium→Svelte→API→DB, backup/restore, compiled worker and browser visual evidence. Keep source assertions rather than weakening them if a browser/PG failure is observed; separate flaky Chrome CDP issue #164 remains open.

Synthetic F1 engineering only: no real customers, providers, payments, production deployment or commercial pilot.
