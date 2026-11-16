# Cookie F1 — post-merge main integration verification (2026-11-16)

**Gate: PENDING new full CI on this exact main-plus-document PR tree. Not release-approved.**

## What actually merged

GitHub [PR #216](https://github.com/tim8es/cookie/pull/216) merged as **`24c9a601bc6359c806308777bdbe18a7a999b186`** with parents `2970dc4d82717a3dbdd04ed74f149447477a9721` (new architecture/Booking main) and `962bd47e4aa9fd4b556841410b37c0ece42ba335` (independently reviewed QA consolidation). Its three older source leaves [#207](https://github.com/tim8es/cookie/pull/207), [#209](https://github.com/tim8es/cookie/pull/209) and [#213](https://github.com/tim8es/cookie/pull/213) were closed **without merging** to prevent duplication.

The merge tree was independently checked against both parents. Real `scripts/f1-browser-cdp.mjs` blob `2821f22433b68901ac05eab52a14b09e4a37d282` and `apps/api/test/booking-http.integration.test.ts` blob `1f077f2206c6f89e4c10200527e10416893f8047` are **byte-identical to final QA #216**. The merged `package.json` blob `dc2fc9c6fa20be20d1570c49a1c7e84eb5324958` carries **both** unit-gated `node --test scripts/f1-chromium-startup.test.mjs` and architectural `node --test scripts/check-boundaries.test.mjs`; neither was lost during the merge.

## Why a post-merge full run is still required

[Pre-merge #216 run #43942488706](https://github.com/tim8es/cookie/actions/runs/43942488706) completed SUCCESS (two attempts, same SHA) with 103+5 unit, 66 PG16 integration, 49 web and Chromium browser, but it preceded 31 architecture/Booking commits subsequently incorporated through the merge. GitHub did **not** expose a workflow run for the exact main merge SHA when inspected. A green former PR head does not prove this new combined tree.

This documentation-only Draft PR exists solely to run the unchanged `.github/workflows/f1-ci.yml` against **the actual merged app/DB/QA graph**. The full gate must confirm: lint, format, boundaries and boundary regression unit, TypeScript, unit, real PG16 concurrency/migration/Booking/Cookie, backup/restore, compiled worker, Svelte and browser screenshot/HTTP assertions. A failed check is real until triaged; never skip/retry application assertions to manufacture a PASS.

## Remaining blockers regardless of this result

- [#113](https://github.com/tim8es/cookie/issues/113) and [#165](https://github.com/tim8es/cookie/issues/165): security P0 final acceptance, tenant boundaries, revoked role/session/membership and race tests.
- [#175](https://github.com/tim8es/cookie/issues/175): approved Workspace permission read-snapshot / serialization choice, client capability invalidation.
- [#144](https://github.com/tim8es/cookie/issues/144): `main.protected=false`. GitHub rulesets API returns 403 requiring GitHub Pro or public repository; **do not publish private source** as a workaround. Existing CI is not an enforced merge gate.
- [#164](https://github.com/tim8es/cookie/issues/164): intermittent browser startup root cause and longer observation; two green runs are not proof of zero flake.
- [#197](https://github.com/tim8es/cookie/issues/197): source QA is merged; can close only after independent post-merge acceptance and no regression.

No production, customer PII, live Telegram, payments, paid provider or commercial pilot is authorized by any synthetic QA result.
