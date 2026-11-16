# Cookie design iteration 08 — WCAG AA for clay theme secondary copy

**Date:** 2026-11-16 · **Status:** PROPOSED · stacked Draft, synthetic frontend only  
**Parent:** #206 → #199 → previous six design iterations.

## Evidence, not visual preference

The public booking surface has four curated dark palettes. A source-based relative-luminance comparison of all four theme backgrounds against the actual secondary text colors in `apps/web/src/styles/booking.css` found three **normal-sized** text pairs below WCAG AA's 4.5:1 contrast threshold, all on **Терракота**:

| UI text | Current foreground / background | Before | After |
| --- | --- | --- | --- |
| Hero side label `Вы записываетесь в` | `#c4b7c8` / `#704234` | 4.35:1 | 6.10:1 (`#e5dad9`) |
| Ticket top line `ДЕТАЛИ ЗАПИСИ` | `#ddd2e1` / `#805344` | 4.44:1 | 4.97:1 (`#e9dfe0`) |
| Ticket description below `Ваш визит` | `#d4c4d9` / `#805344` | 3.92:1 | 4.97:1 (`#e9dfe0`) |

Calculated with sRGB 2.4 transfer / WCAG relative luminance and rounded to two decimal places. The other curated palettes pass 4.5:1 for these three text elements with their existing colors.

## Smallest production-neutral correction

- Keep original baseline values for Atelier, Forest, Ocean. Introduce three design tokens **only under** `.public-shell.salonThemeClay` and use CSS custom property fallbacks for the existing text rules. Do not change service prices, buttons, backgrounds, layouts, other themes, API or tenant configuration.
- Browser smoke now saves the **clay** theme through the actual mock Appearance editor, opens the real shared booking UI and measures the **computed text and background RGB colors**, not a separately hard-coded color table. Each of the three pairs must have contrast >= 4.5 at 1280, 375 and 320 CSS px.
- Append scene `22-clay-contrast` and require **66** PNGs (22 scenes × 3 widths) in the fail-closed CI manifest. Existing 21 scenes stay unchanged and required.
- The hero side label is intentionally hidden at small widths, but the test still validates its palette; visible ticket copy must also meet contrast.

## Acceptance / caveats

- [ ] Full F1 CI PASS on exact PR HEAD, including Svelte, PG, Chromium, 66-PNG strict visual gate.
- [ ] Actual `22-clay-contrast` screenshots inspected at desktop and mobile widths; no clipping/overflow.
- [ ] Computed-style contrast assertions green and preservation of default theme color and mock-only data.
- [ ] Independent human review; do not self-approve or merge without owner's acceptance.

Automated color contrast is only part of accessibility: this test does **not** establish physical-device, screen-reader, typography legibility, focus ordering or real production authorization. Real public Booking API is still not connected.

## Related artifacts

- [Integrated six-iteration PR #199](https://github.com/tim8es/cookie/pull/199)
- [Sticky screenshot accuracy PR #206](https://github.com/tim8es/cookie/pull/206)
- `apps/web/src/lib/appearance.test.ts` (existing primary theme contrast unit tests)
