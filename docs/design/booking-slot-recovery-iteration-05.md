# Cookie — design iteration 05: no-slots and booking recovery

**Date:** 2026-11-16  
**Status:** PROPOSED / Draft implementation, synthetic F1 UI only  
**Stacked base:** PR #184 → #169 → #163 → #158  
**Ownership:** Public `BookingForm.svelte`, its presentation CSS, and browser smoke. No shared Booking API/Identity/Policy/DB changes.

## Evidence-based problem

Existing public `BookingForm` conflates three conditions under the text `Свободных демонстрационных интервалов нет. Выберите другой день или настройте график мастера`:

1. A **real empty response** to an availability lookup for a valid selected service/staff/location/date;
2. Missing staff/location/date prerequisites (not an empty response);
3. A **failed request** (the outer App separately shows a global error, but the slot area still looks empty).

The customer-facing text also invites a guest to `настройте график мастера`, a business action. This violates the salon-first public/owner boundary fixed by iterations 01–04. ADR-0005 requires accurate empty/error states and recovery without inventing API outcomes.

## UI rules implemented

- Missing requirements: neutral instructions to select a specialist/date; do not claim that a checked day has no availability.
- During lookup: `role=status` pending message, no buttons implying available slots.
- A failed lookup: inline `role=alert` state `Не удалось проверить время` with **Повторить проверку**; keep a short generic message, never render raw transport or credentials to a guest.
- Successful zero-slot lookup: `role=status` state `На выбранный день нет свободного времени`, explanation and one accessible outline Button `Проверить следующий день`. It advances the selected date by exactly one calendar day and invokes the existing `onDateChange` port, which triggers an ordinary slot refresh. **It never guarantees the next day is available**.
- In all conditions, the service/master/date selection remains editable. Previous selected times are reset whenever a lookup begins. Existing submit gate `canBook` retains responsibility for preventing fabricated booking.
- Use native date input and existing Button primitive; keep keyboard navigation, 44px touch target, salon brand/theme, mobile responsive rules and explicit synthetic-data caveat.
- Do not trigger blind multi-day scans or generate availability on the frontend.

## Negative/positive evidence required

1. With a configured synthetic salon, choose a non-working Sunday: slot area shows no-availability messaging and no owner configuration instruction; no slot buttons, Create disabled.
2. Click **Проверить следующий день**: selected date changes to Monday; the ordinary mock adapter returns fixture slots; Create is still disabled until the client selects a time.
3. No service/master/location/date: no false `нет свободного времени` statement.
4. Failed read: generic inline error + retriable action (without falsely declaring no slots); on retry, preserve guest selection but still reset time and requery.
5. Exact-head CI build + typecheck + PostgreSQL/unit + browser smoke at 1280×800, 375×812, 320×568; screenshot empty/recovered states. Screenshot CSS viewport tests **do not** imply real touch/WebView or live booking PASS.

## Explicitly out of scope

Authenticated roles, real availability algorithm, atomic Confirmed Booking, conflict/retry semantics from backend, quote/discount calculation, personal data, payment, Telegram initData, production URLs and rollout. Server retains authority over slots/pricing and state.

## References

- [ADR-0005 — shared Booking UI](../architecture/ADR-0005-shared-booking-ui.md)
- [F0 screen map](../architecture/f0-implementation-blueprint.md#5-screen-map--готовый-документальный-набросок-не-дизайн-макеты)
- [Iter. 04 — upfront catalog cost](booking-price-hierarchy-iteration-04.md)
- [Issue #13 — public UI](https://github.com/tim8es/cookie/issues/13)
- [Issue #23 — F1 web E2E](https://github.com/tim8es/cookie/issues/23)
