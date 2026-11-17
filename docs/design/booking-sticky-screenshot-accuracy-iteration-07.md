# Cookie — Design iteration 07: credible sticky-layout screenshot evidence

**Date:** 2026-11-16  
**Status:** PROPOSED, Draft QA fix on top of integration PR #199.  
**Source:** checked 1280×800 and 375/320 CSS viewport screenshots from #199's exact-HEAD CI #43932889176, `apps/web/scripts/browser-smoke.mjs`, and `apps/web/src/styles/booking.css`.

## Visual finding and root cause

The desktop screenshot `1280x800-02-booking.png` from the otherwise green integration run shows the right-side `Детали записи / Ваш визит` card starting much lower on the page than the booking form. Previous QA classified this as possible alignment polish.

Code inspection identifies a **test-capture artifact**:

- The public form's grid has `align-items: start`, and the right `.booking-summary-container` uses `position: sticky; top: 20px`.
- Before taking the `02-booking` screenshot, the Chromium smoke has scrolled to and clicked the time selection, so `window.scrollY` is nonzero.
- `captureEvidence` was requesting a **full-document** screenshot starting at `y: 0` but **never resetting the actual document scroll**. Sticky elements render according to the current viewport scroll state even when the captured PNG covers the full document. Therefore the card's low position in the screenshot cannot be used to conclude that the initial customer view is misaligned.
- Automatically changing CSS to move the card upward would risk breaking the correct sticky behavior on the real page.

## Scoped fix

1. Before each full-page visual capture, scroll the tested viewport to `window.scrollY = 0`, allow layout to settle, and assert the screenshot really starts from the top. Do **not** change the intentional viewport-only `05-detail` capture.
2. For desktop `02-booking`, inspect the actual DOM geometry at scroll top. Require the panel and summary wrapper to share the same top anchor to within 2 CSS pixels. This **fails CI** if the UI genuinely becomes vertically misaligned.
3. After screenshot capture, restore the prior scroll position. This avoids changing the subsequent interaction test behavior.
4. Keep the existing strict screenshot manifest: 21 scenes × 3 viewports, expected exact PNG filenames, correct dimensions, no duplicates/missing files, no external requests. No CI assertion or production style is removed.

## Acceptance

- [ ] Exact-HEAD full F1 CI passes, including `apps/web/scripts/browser-smoke.mjs` and `scripts/ci-visual-evidence-check.mjs`.
- [ ] `1280x800-02-booking.png` now shows the right visit summary beginning adjacent to the left form, rather than displaced by the test scroll.
- [ ] `375x812-02-booking.png` and `320x568-02-booking.png` retain their mobile collapsed summary and reading order.
- [ ] The `05-detail` screenshot still captures the actual current viewport; all 63 scene PNG files continue to validate.
- [ ] The actual sticky follow-on-scroll behavior is not claimed validated by the full-page screenshot. Any new sticky interaction assertions should be a separate, targeted test.
- [ ] Independent design review and owner approval remain required before integration PR merge.

## Boundaries

No UI CSS, production logic, API, data, booking or permissions changes. Only deterministic visual evidence and one geometry assertion. The UI remains a synthetic browser demo. No production rollout or commercial pilot permitted.
