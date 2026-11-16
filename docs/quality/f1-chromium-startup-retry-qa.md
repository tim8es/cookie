# F1 Chromium CDP startup reliability — bounded pre-CDP retry

**Status: VERIFIED in consolidated current-main F1 CI; independent review and merge pending.** [Issue #164](https://github.com/tim8es/cookie/issues/164). F1 engineering/test infrastructure only. Source baseline is `main` `476eb9a3ed80024b203898e35aab6f6a1cfb7520`, after #193 and #194 were merged. No production browser, real data, provider, payment, pilot or deployment.

## Observed issue and scope

On intermittent F1 CI jobs, `apps/api/test/booking-http.integration.test.ts` fails **before any browser-originated POST** because headless Chromium does not expose `DevToolsActivePort` or loopback CDP `/json/list` within the startup window. Historical [#164](https://github.com/tim8es/cookie/issues/164) records `ECONNREFUSED`. The later [PR #193 run #43930722164](https://github.com/tim8es/cookie/actions/runs/43930722164) showed `Chrome DevToolsActivePort timed out`; rerunning the same failed job without changing source succeeded (103/103 unit, 66/66 PostgreSQL 16, 46/46 web). A transient startup failure is **not evidence that Booking or security logic is broken**, but it currently rejects otherwise valid builds. The exact root cause (runner resource pressure vs Chrome process startup) is not yet established.

## Safeguard

Only `scripts/f1-browser-cdp.mjs` is affected (the real Fastify / PostgreSQL browser-to-booking F1 test). It now uses a separate `scripts/f1-chromium-startup.mjs` helper:

- Start Chromium with its own fresh temporary user-data directory and `--remote-debugging-port=0`; Chrome itself chooses an ephemeral loopback CDP port. Never guess a port and create a bind race.
- Limit to **two** startup attempts with **12-second** per-attempt readiness deadline, 100ms probes. A readiness success requires a well-formed `DevToolsActivePort` **and** a real HTTP 200 on loopback `/json/list` with a page WebSocket endpoint.
- If Chrome exits before readiness, report its real exit code or signal and bounded, local Chromium stderr. If CDP discovery fails or times out, report the last probe error. Cleanly send SIGTERM; if needed send SIGKILL, await process reap, remove abandoned browser profile **before** retrying.
- If cleanup itself fails, **fail closed immediately** rather than launch an overlapping browser. Two startup failures fail CI with both attempt diagnostics. No catch-and-PASS mechanism.
- After a single CDP endpoint is returned, the previous browser automation path is unchanged: exactly one Svelte `BookingForm` click, real HTTP **201/409/403** verification, fresh `GET /availability` and removal of occupied slot after 409, database idempotency/receipt/Outbox and no unauthorized writes after 403, browser error checks and 375px layout. No retry on any request, assertion, renderer error or Postgres failure. No test is skipped, mocked or given synthetic authorization it did not already have.

## Deterministic regression proof

`scripts/f1-chromium-startup.test.mjs` is run by the existing `pnpm test` gate (five Node-native tests without launching browsers):

1. A process that exits before readiness is disposed **before** the second attempt.
2. Successful first attempt is never retried or disposed prematurely.
3. Two readiness failures produce an explicit bounded exception with both diagnostics and dispose both attempts.
4. Cleanup failure aborts immediately with no second spawn.
5. A request for a third/unbounded attempt is rejected before spawning.

The **real** Chromium/HTTP/PostgreSQL integration still runs unchanged through `pnpm test:integration`. Existing web Chromium smoke also runs unchanged later in F1 CI. Manual local verification can run `node --test scripts/f1-chromium-startup.test.mjs`, but **only a full exact-head GitHub F1 run** proves the CI integration tree. To claim reduced flakiness, observe repeated successful runs on identical commits; one pass is insufficient.

## Limits and release decisions

This is test infrastructure stabilization, **not** a change in authorization semantics and **not** a resolution of strict role-read policy [#175](https://github.com/tim8es/cookie/issues/175), Booking [#113](https://github.com/tim8es/cookie/issues/113), Cookie session [#165](https://github.com/tim8es/cookie/issues/165), or unprotected main [#144](https://github.com/tim8es/cookie/issues/144). Keep #164 open until repeatability is demonstrated and no test failures are silently retried. Production and commercial pilot remain prohibited.

## Consolidated current-main integration evidence (2026-11-16)

[Draft integration PR #216](https://github.com/tim8es/cookie/pull/216) combines unchanged test/code blobs from #207, #209 and #213 **on main `54a77bd035e9df6d0157ecfa140a2df81c562ae4`**, after the salon-first UI changes. The [first exact-integration-head F1 run #43941593608](https://github.com/tim8es/cookie/actions/runs/43941593608) is **SUCCESS**: 103 original unit + five CDP-startup unit, **66/66 real PG16** integration, **49/49 updated web** unit tests, restore, compiled worker, API/Svelte builds and browser smoke. Historical leaf/stack descriptions above document their original source branches, **not the proposed merge order**. The sole candidate for final review is #216; do **not** merge its three superseded leaves separately or infer approval of unrelated security/policy gates. The browser, availability and Booking assertions are unchanged from already-green #213 SHA `642d2e244476b9208aefdb548de2c18a2a04f6ed`. This evidence does not mean the work is merged or released; require independent review and full CI on the final commit after any edits.
