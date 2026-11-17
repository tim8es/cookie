# Cookie — salon-first Booking UI: design iteration 01

**Date:** 2026-11-16  
**Status:** DESIGN IMPLEMENTATION DRAFT — synthetic F1 only; owner review required before merge.  
**Baseline:** `main` at `00ebfc0`, ADR-0005 (shared public web / iframe / Telegram Mini App), REQ-015 (F2 branding), UX direction *Studio Appointment Journal*.  
**Scope:** public booking shell, design guardrails and test evidence; **not** a production public URL, auth, real tenant branding, iframe integration or Telegram SDK.

## Product intent

The customer sees the **salon as the primary product identity** and Cookie as a small, recognizable technology credit. A salon owner will eventually customize branding easily without CSS or code. The same trusted tenant configuration will feed public web, iframe and Mini App.

### Non-negotiable separation

1. **Customer UI:** salon name/visual identity first, simple task (choose service → practitioner/location → day/time → verify booking). There must be no owner/admin workspace navigation.
2. **Owner workspace:** operational navigation, calendar, catalog, team and future appearance settings. The owner brand is Cookie; the customer-facing brand belongs to the salon.
3. **Synthetic F1 demo:** returning to the mock workspace is permissible **only as an explicitly marked demo/testing escape hatch**. The escape hatch must not look like a customer-facing product navigation item or imply a real role/auth session.
4. **Attribution:** one understated `Работает на Cookie` credit, placed in the public footer, visually subordinate to the salon. Never a dominant header/hero icon or intrusive watermark.
5. **Safety:** do not turn mock booking into real Confirmed; do not assume bearer/token, org mapping, custom-domain routing or transport contracts. Do not accept untrusted tenant themes through URL parameters.

## Iteration 01 — implemented/targeted UI changes

- Replace Cookie's decorative mark in the public booking header with a text-safe salon monogram and the tenant's synthetic display name.
- Remove the demo `В кабинет` navigation button from the primary public header. Keep a clearly labeled **demo-only** return control in the non-production notice, driven by `demoMode`.
- Remove first-party Cookie naming from the large client hero; retain a tasteful generic editorial composition and salon context.
- Relegate Cookie attribution to one small footer treatment, separate from operational demo diagnostics.
- Keep a no-data/network guarantee in mock mode, current user-visible synthetic labels, calendar/receipt behavior and accessibility-focused controls.
- Maintain the existing viewport smoke (1280, 375, 320) and add DOM assertions for salon identity, subtle Cookie credit and absence of owner navigation in the customer header.

## Future iterations (not claimed implemented by this change)

### Iteration 02 — configurable owner branding (REQ-015, F2)

Define a versioned `OrganizationAppearance` contract and scoped admin UI. Editable properties: logo image, primary/secondary accents with contrast-safe pairing, a limited choice of typography, optional cover image, short salon description and booking-page preview. Save and publish transactionally by authorized owner/administrator only. Support reset to accessible defaults and distinguish Draft vs Published appearance; preserve org identity across locations. Public page receives **validated, trusted** configuration from backend, never user-provided query or iframe payload.

### Iteration 03 — independent guest entry and shared shells

Dedicated tenant/branch entry routes, secure iframe bootstrap with origin validation, browser guest management, and Telegram Mini App shell + verified launch/session. Client must not see a direct navigation path into business workspace. All channels use the same Booking API and authoritative Quote/Availability.

### Iteration 04 — faster mobile booking and operational owner calendar

Study real target-device tasks: allow customer to scan services and free dates early, expose current price and location, minimize repeated form entry, ensure sticky submit and accessible errors/409 recovery. Owner views prioritize appointment/time/staff and quick permitted actions. No invented API behavior.

## Visual quality rules (Taste Engine)

- **Hierarchy:** one primary action per screen, salon first, Cookie secondary; remove decorative emphasis from competing headings. Hero must not push the first meaningful booking control excessively below the fold on 320–375px.
- **Palette:** retain the carefully constructed Studio Appointment Journal base for the demo, but separate product shell tokens from future trusted salon theme tokens. No freeform text over arbitrary low-contrast custom colors.
- **Typography:** editorial headings only where they add orientation; operating controls use the readable system sans. Never sacrifice input label legibility for aesthetics.
- **Geometry:** align form and summary to a consistent grid, keep one-column mobile order and at least 44px touch targets.
- **Anti-rules:** no generic dashboard card explosion, no decorative fake metrics, no Cookie logo competing with the salon's, no unvalidated style injection or false server confirmation.

## Acceptance & evidence

1. In mock mode, create `Студия Smoke` and navigate to booking: header has salon name/monogram, not Cookie logo or business workspace header.
2. Public header contains **no** `В кабинет` button. Any return to the mock workspace is in an explicit demo notice; no such link in non-demo modes.
3. Public client page has exactly one subordinate Cookie credit. The hero does not say `Cookie / запись к мастеру`.
4. Existing synthetic booking, move/cancel/calendar, reset and 3 viewport smoke continue working.
5. Mock mode makes no external network writes; normal `api` mode remains intentionally fail-closed.
6. Browser screenshots are reviewed separately for layout/crop/contrast. CI is not a substitute for physical mobile and Telegram WebView testing.

**Release gate:** Draft PR, exact-HEAD CI, independent visual review, owner sign-off. **No production deployment or real customer data.**

## References

- [ADR-0005](../architecture/ADR-0005-shared-booking-ui.md)
- [Product requirements, REQ-015](../product/requirements.md)
- [Current visual direction](../../apps/web/DESIGN.md)
- [Owner/frontend contracts and missing adapters, #66](https://github.com/tim8es/cookie/issues/66)
- [Technical E2E, #23](https://github.com/tim8es/cookie/issues/23)
