# F1 QA #197 — correlate post-409 browser availability body with rendered choices

**Status: PENDING exact-head stacked F1 CI.** [Issue #197](https://github.com/tim8es/cookie/issues/197). This test-only assertion is stacked on independent Chromium startup reliability [PR #207](https://github.com/tim8es/cookie/pull/207), HEAD `e05464f66328d3c204223cafaf294dcc73a50a75` (itself based on merged `main` `476eb9a3ed80024b203898e35aab6f6a1cfb7520`). PR #207 already has two full green F1 CI attempts on the same exact SHA; the additional QA assertions in this branch need **their own independent full CI**, not inherited parent PASS.

## Gap and strict test assertion

Merged [#152](https://github.com/tim8es/cookie/pull/152) + [#195](https://github.com/tim8es/cookie/pull/195) confirm the Booking POST HTTP **201/409/403**, one request, a post-409 availability GET and removal of the newly occupied slot. Those checks still permit a locally fabricated or stale *non-empty* alternative list that happens not to contain the conflicting slot.

The test-only CDP driver `scripts/f1-browser-cdp.mjs` now captures real `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFinished` and `Network.getResponseBody` for the availability GET sent **after** the correlated Booking 409. It requires:

1. Exact Booking POST 409 and exactly **one** POST; no optimistic Confirmed receipt or automatic mutation retry.
2. Availability GET happened **after the observed 409 response**, not just before clicking Submit. Inspect its exact CDP request ID and response body; require HTTP 200, parse its JSON `slots`.
3. Compare the fresh GET URL **pathname and serviceId/staffId/date query** with the initial availability GET, proving identical Tenant, Location, Service, Staff and location-local date.
4. Every rendered `.booking-attempt-slot-options button` label equals the actual backend GET response slot's `startAt` UTC HH:mm (the fixture uses UTC). Exact ordered equality, **no hardcoded or stale/fabricated alternatives**.
5. The backend's fresh list and the UI both exclude the newly occupied slot. Preserve existing 375px horizontal overflow, browser exception, outbound network, POST status and receipt/Outbox/DB checks.

This is **not** a Node-side second API query and cannot pass by comparing to a locally rebuilt slot list. No business code, Svelte component, SQL migration or production client API changed.

## Gaps not silently claimed

The current synthetic live-browser fixture has a known nonempty alternative set. **Zero-slot and failed post-409 GET UI recovery** plus desktop-width checks are separate remaining acceptance cases under #197, requiring dedicated server fault/empty fixture behavior and fresh F1 browser evidence. The new assertion does **not** label #197 fully closed. Existing pure `BookingAttempt` unit coverage is not a substitute for a browser-fetched empty/error response. This source is an opt-in local Fastify/Svelte/PostgreSQL QA fixture, not a live consumer/Telegram Mini App or production route.

Keep #197 open until independent acceptance of those additional cases. #113, #165, #175, #144 and live PII/provider/pilot/production gates remain separate. Do not merge this test without parent #207 or reconstructing on updated main with exact-head green F1 CI.
