# Cookie design iteration 04 — upfront price and functional visit summary

**Date:** 2026-11-16 · **Status:** PROPOSED (synthetic frontend, owner review required)  
**Stack:** #158 → #163 → #169 → iteration 04.  
**Scope:** only the public Booking UI and Chromium visual/DOM checks. No public launch, payment, role simulation or pricing engine.

## Observed, reproducible UX defects

In verified [iteration 03 CI screenshots](https://github.com/tim8es/cookie/actions/runs/43910232808) at 1280×800, 375×812 and 320×568:

1. **Important price too late on mobile:** service picker presents a name and duration but not its price. The `booking-checkout-summary` price appears only after several form sections; right-side ticket is folded on mobile. This makes price discovery depend on scrolling to the bottom, despite a known demo base price.
2. **Desktop summary prioritizes decoration over information:** the ticket has a large petal-like mark and a multi-line slogan before the service and appointment details. Cookie's own ornament should not visually outrank salon, service, time and price.
3. **Preliminary cost must not imply a guaranteed price:** accepted pricing DEC-055 allows a more recent server quote at CreateBooking; the synthetic UI must label the displayed amount as **preliminary catalog price**, not a contractual rate.

## Decisions implemented in this iteration

- Each service option shows `Service name · preliminary RUB price`; after selection display a compact inline `duration + preliminary price` summary directly below the field. Existing checkout summary remains for final review.
- The service control stays a native select with a visible label, focus style and keyboard access; no custom dropdown or client-side pricing algorithm.
- The desktop visit summary becomes a compact functional receipt: simpler `Детали визита` heading, no petal-like platform symbol or repeated marketing slogan; the data remains in the same order.
- Keep the single-column mobile flow, tested 44px targets, explicit `demo` limitations and quiet `Работает на Cookie` footer. The preview theme still applies.
- No new field, login, API token, customer PII, custom CSS configuration, pricing discount math or real booking confirmation.

## Non-goals

- A new server Quote endpoint, staff/location prices, discount compatibility or price-lock guarantee.
- Native client account, contact verification, guest manage booking, iFrame, Telegram launch validation.
- Artificial "savings" badges, promotional rates, invented prices or fake scarcity.

## Acceptance

1. For a selected demo Service with base catalog price 1,500 ₽ and duration 60m, price appears immediately after the Service select **before** the practitioner, date and final checkout controls; all four curated themes inherit neutral accessible pricing typography.
2. Every other available service picker option includes its actual synthetic base price. On change, inline duration/price updates reactively; if none selected, no invented amount is displayed.
3. Summary emphasizes service, staff, location, date, time and preliminary cost. No four-petal brand mark nor headline `Ваш визит в одном месте`.
4. Browser smoke on 1280/375/320 verifies service price DOM, maintains 201-only synthetic booking state, no owner calendar navigation, no page overflow and correct accessible controls.
5. Existing tests and full F1 CI pass at exact PR head. Review the screenshots and note physical/mobile testing not completed.

## Design system rationale

Preserve *Studio Appointment Journal* typography/palette and generous space but favor task-critical information over decoration (Taste Engine principles: hierarchy, proportion, restraint, accessibility). Cookie remains an understated attribution, never the center of a tenant's booking page.

**Next:** genuine server Quote and verified guest booking flow (separate engineering PR). Do not tag real availability, auth or payment as PASS.
