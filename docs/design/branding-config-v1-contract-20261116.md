# Cookie Branding — v1 design tokens & reusable owner editor

**Status:** IMPLEMENTED FRONTEND CONTRACT / NOT YET CONNECTED TO REAL BACKEND  
**Date:** 2026-11-16  
**Issue:** #223 (real tenant branding), #203 (boxed runtime), #222 (real public URL)  
**Baseline:** ADR-0001 minimal kernel; ADR-0005 shared public Booking UI, REQ-015/018.

## What this PR implements

The shared frontend now has `apps/web/src/lib/branding-config.ts`:

- Four strictly defined presets (not infinite templates):
  - Atelier — light, editorial, soft controls;
  - Forest — dark, humanist, pill controls;
  - Ocean — light, modern, compact controls;
  - Clay — dark, classic, rounded controls.
- User override fields: primary, accent and page-background hex colors, light/dark mode, four finite button-radius options, typography options and accent-decoration variants.
- `BrandConfigV1` with explicit version, preset ID, bounded choices and **opaque IDs** for logo/background assets. No URL string, SVG, CSS property body or embedded data URI is accepted as an asset reference.
- `validateBrandConfig(raw)`: fail-closed publish-oriented validation; unknown fields and versions are rejected; accent/primary contrast must be at least 4.5:1.
- `compileBrandTokens(raw)`: returns only finite, safe CSS variables whose values are checked hex strings or owned enum tokens. Browser text contrast on custom primary/backgrounds uses WCAG relative luminance and picks a contrasting light/dark ink.
- Unit tests for four presets, light/dark distribution, valid custom colors/shapes/fonts, unsafe CSS, remote asset URL, invalid contrast and versioning.

`apps/web/src/lib/ui/BrandingSettingsEditor.svelte` is a transport-neutral, production-oriented reusable component:

- 4 preset cards; three safe color selectors; light/dark, buttons, typefaces, accents;
- logo/banner file pickers, explicit upload callbacks;
- status of **published server revision**, unsaved changes; Save draft and Publish **separate actions**, both controlled by parent API state;
- preview built only from validated tokens, with safe fallback while invalid edits are corrected;
- file type and size precheck (PNG/JPEG/WebP, max 2 MiB); real upload security and MIME verification are **server responsibilities**;
- no local fake server save, no direct `sessionStorage`, no arbitrary external URLs and no pretending preview is published.

## What is NOT yet implemented

**The component is intentionally not mounted in the existing mock-only `App.svelte`.** This PR is a reusable contract and editor, **not the live end-to-end branding feature**. Existing demo Appearance UI remains separate. #203/#223 must provide:

1. Real Organization/Role/Session and read/write/publish API ports.
2. Tenant-scoped PostgreSQL `AppearanceDraft` and `AppearancePublished` revision, including rollback/optimistic concurrency.
3. Authorized asset upload with server-side content sniffing, strict type/size/dimensions, re-encoding, tenant IDOR protection and safe same-origin thumbnail.
4. Root owner routing that mounts the editor with actual callbacks and server state, not demo local storage.
5. Public salon route #222 that loads **published** config and maps tokens to the shared Booking page. Do not reuse owner draft or client-provided query styles.
6. Independent browser-to-DB E2E test from two isolated browser sessions and multiple tenants, including restart persistence, invalid-asset rejection and no-script/XSS/CSS injection.

## Product guardrails

- Only four shipped presets, not four font/theme asset dependencies; initial system font stacks support fully offline boxed deployments.
- Owner account shell stays Cookie-branded. Public branding applies only in a tenant-scoped public shell.
- Module lives in business/channel integration, never kernel. Deployment may include base Appearance module; permissions/entitlements determine if advanced customization is enabled for a tenant.
- Background image opacity and contrast need production accessibility review after actual asset is processed. Current color contrast calculations cannot prove legibility over arbitrary images. For release, darken/scrim untrusted photographs or restrict images to decorative areas outside text.
- Optional Group Sessions (#224) must reuse the same published appearance tokens without introducing a new page theme or changing the kernel.
- Do not mark #223 complete until actual real server + public page acceptance tests pass.

## Acceptance for this scoped PR

- [ ] CI on exact PR SHA (lint, formatting, TS, unit, Svelte check/build, PG regression, existing browser smoke).
- [ ] Existing synthetic browser smoke remains unchanged and safe, no new external network requests.
- [ ] Server asset and real publish integration remain clearly deferred to #223, no fabricated link or success state.
- [ ] Independent design and architecture review requested before merge.
