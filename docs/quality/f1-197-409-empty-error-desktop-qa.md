# F1 QA #197 — genuine post-409 empty/error fallback, mobile + desktop

**VERIFIED on consolidated current-main PostgreSQL16+Chromium CI; independent review and merge pending.** Independent test-only follow-up to [#197](https://github.com/tim8es/cookie/issues/197) and [QA PR #209](https://github.com/tim8es/cookie/pull/209), stacked over its head `b82d3a25ccececd8d4799948cb99a8b81f5c00e8`. Parent #209 already has [full successful F1 CI #43937796812](https://github.com/tim8es/cookie/actions/runs/43937796812); **that CI does not prove this new diff**. #209 itself depends on [startup PR #207](https://github.com/tim8es/cookie/pull/207) (two complete green attempts). No production/public endpoints, user PII, real payments, providers or pilot.

## Acceptance already in parent QA #209

1. Browser sees exactly one Booking POST HTTP **409** after another permitted actor reserves selected `12:00`; receipt/Confirmed UI must remain absent.
2. CDP correlates the **post-409** `GET /availability` request ID with response status and exact `Network.getResponseBody` JSON (not a Node-side GET). Tenant/Location path and Service/Staff/date match the original request.
3. Every displayed alternative equals the backend's freshly fetched `slots[].startAt` times in order; occupied `12:00` is absent; real 201/409/403, booked rows, Outbox, layout remain enforced.

## New exact real-HTTP/PG16/Chromium modes

After preserving the original three browser positive/negative tests and verifying the revoked-owner HTTP 403 with zero unauthorized writes, the synthetic fixture re-enables **only its own test identity**. It then runs two *additional*, distinct browser sessions.

**Empty-but-valid (375px):**
- Initial GET returns a real available `14:00` option from the PostgreSQL shift.
- On the browser's pre-submit checkpoint another authorized synthetic actor **commits** `14:00` via the real Fastify Booking POST (HTTP 201), then closes the shift in a separate PG write.
- Browser POST observes real HTTP **409** and performs the post-409 GET, which returns **HTTP 200 with `slots: []`** (valid zero availability).
- Assert ordered equality between the actual CDP response JSON and rendered alternatives (both exactly empty), no confirmed receipt, no stale booking options, **no false network-error copy**, visible safe `Изменить дату или мастера` recovery, no new unauthorized booking/receipt/Outbox, no viewport overflow. The test restores the shift in `finally`.

**Backend availability failure (1280px desktop):**
- After the same original available-slot proof, a synthetic competing actor commits `16:00` via real PG/HTTP 201.
- An isolated test-owned PG pool proxy injects a one-time **availability SELECT fault only** on subsequent GET, without interfering with any Booking POST SQL, transactional permission checks or production code.
- Browser POST is still real **409**, but the post-409 GET receives the actual **HTTP 503**, correlated to the same Tenant/Location/Service/Staff/date. The Svelte state must show `Не удалось обновить свободные интервалы`, **zero stale alternatives**, safe selection recovery, no optimistic Confirmed, exactly one POST and no horizontal overflow at 1280px.
- The synthetic fault switch is cleared in `finally`. No Fastify production route is weakened or an expected error replaced by local UI mock data.

**Database and coverage:** fixture's existing 5-booking/7-receipt/7-Outbox baseline after 201+409+403 becomes exactly 6/8/8 after the legitimate empty-case competitor and 7/9/9 after the legitimate error-case competitor; **failed browser attempts add no durable Booking/receipt/Outbox**. Existing 201/409/403 assertions, explicit idempotency evidence, Chromium exceptions and external-network checks remain intact.

## Verification and limitations

Full exact-head `.github/workflows/f1-ci.yml` required: lint, Prettier, TypeScript/boundaries, 103+5 unit, real PG16 migrations/integration, backup/restore, compiled worker, Svelte build, browser screenshots and smoke. An early infrastructure/browser fixture error is **not** a confirmed application bug. Fix the test without disabling assertions.

This QA is a **synthetic** Fastify/Svelte loopback; real customer and Telegram SDK workflows need their own integration acceptance. The 375px empty state and 1280px refresh error are separate viewport/scenario samples, not physical-device validation. Do not mark #197 fully resolved before reviewers accept the exact merged suite and evidence; do not skip parent dependencies, enable public Booking, or deploy commercial F1.

## Consolidated current-main integration evidence (2026-11-16)

[Draft integration PR #216](https://github.com/tim8es/cookie/pull/216) combines unchanged test/code blobs from #207, #209 and #213 **on main `54a77bd035e9df6d0157ecfa140a2df81c562ae4`**, after the salon-first UI changes. The [first exact-integration-head F1 run #43941593608](https://github.com/tim8es/cookie/actions/runs/43941593608) is **SUCCESS**: 103 original unit + five CDP-startup unit, **66/66 real PG16** integration, **49/49 updated web** unit tests, restore, compiled worker, API/Svelte builds and browser smoke. Historical leaf/stack descriptions above document their original source branches, **not the proposed merge order**. The sole candidate for final review is #216; do **not** merge its three superseded leaves separately or infer approval of unrelated security/policy gates. The browser, availability and Booking assertions are unchanged from already-green #213 SHA `642d2e244476b9208aefdb548de2c18a2a04f6ed`. This evidence does not mean the work is merged or released; require independent review and full CI on the final commit after any edits.
