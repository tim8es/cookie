# Cookie — appearance preview (design iteration 02)

**Status:** UI PROTOTYPE / synthetic-only F2 exploration; not an approved commercial feature.  
**Based on:** Draft #158 (salon-first public shell). Owner review needed; use with test organization data only.  
**Related:** REQ-015, #27, ADR-0005, #24, #66.

## Problem

The first booking demo used one Cookie visual identity for every salon. The user-approved product direction is **salon-first identity** with a discreet `Работает на Cookie` credit and easy owner personalization. The current real backend does **not** yet provide trusted appearance storage, authenticated owner privileges, logo uploads, public tenant routes or API-mode booking.

## Implemented in this prototype

- Separate **Оформление** destination in owner demo navigation (desktop and mobile More menu).
- Four curated visual themes: **Ателье**, **Ботаника**, **Горизонт**, **Терракота**. Each has explicitly paired dark and light colors; no arbitrary unsafe CSS input. Contrast on hero foreground and accent is tested against 4.5:1.
- Editable introductory sentence, maximum 120 characters, with client-side validation.
- Live miniature view of the chosen palette, salon name and intro text; explicit statement that it is **not** the active booking screen.
- The owner clicks `Сохранить оформление демо`, the synthetic adapter persists a validated appearance to `sessionStorage`; opening **Онлайн-запись** shows the same shared Booking UI with the selected theme/introduction.
- Old demo sessions without `appearance` get a safe default, reset clears the preview, and API mode continues to fail closed. No actual backend requests or client PII.

## Design decision boundaries

- This is a **preview of interaction design**, not the final full-featured brand manager.
- The Cookie attribution remains visible and low priority. It cannot be removed through the demo editor.
- Owners may experiment, but real user roles are not implied: the editor is local mock UI with no AuthN/AuthZ.
- No user-provided HTML, CSS, arbitrary hex values, externally sourced photos, URL-token branding or untrusted iframe overrides.
- Real publication must use server-owned validated OrganizationAppearance and authenticated role+tenant policy, with Draft/Published, audit and rollback; no direct client-side flag can grant public branding changes.

## Pending UX/product decisions and future F2 work

1. Decide whether brand configuration is shared at Organization level or can be overridden per Location (with predictable inheritance).
2. Define safe upload pipeline for logo, hero image and asset lifecycle; choose mandatory alt text and image crop UI.
3. Define supported palette and typography customizations with guaranteed contrast and a `Reset to defaults` flow.
4. Define true owner preview and publish semantics: Save draft → Review desktop/mobile → Publish. No unreviewed silent public change.
5. Trust contract: public tenant resolution, iframe allowlisted origin, verified Telegram launch/session, no custom theme from a raw query string.
6. Validate with real users: first-time owner customization without programming, readable receipt and booking CTA on 320/375px, keyboard navigation and physical-device evidence.

## Acceptance (iteration 02 only)

- Owner can open **Оформление** in mock demo and switch theme without network requests.
- Preview reflects theme and text immediately; **Save** persists for the current tab and survives reload.
- Returning to Booking uses saved appearance, not unsaved draft; Cookie attribution remains.
- Invalid themes / oversized or empty messages are rejected by the mock adapter.
- Legacy demo storage and reset do not throw.
- Automated tests assert theme semantics, measured contrast, storage behavior, API fail-closed and 1280/375/320 browser screenshots.
- Production approval, payments, real PII, auth, iframe and Telegram integration **are not covered**.

## Source of truth

- [First salon-first shell iteration](salon-first-booking-iteration-01.md)
- [ADR-0005 shared Booking UI](../architecture/ADR-0005-shared-booking-ui.md)
- [Project issues #27](https://github.com/tim8es/cookie/issues/27), [#66](https://github.com/tim8es/cookie/issues/66)
