# Cookie design iteration 03 — client-safe booking completion

**Date:** 2026-11-16  
**Status:** PROPOSED, implementation in stacked Draft PR; synthetic F1 UI only.  
**Base:** Design iteration 02 (PR #163) → iteration 01 (PR #158) → main.  
**Source:** ADR-0005, ADR-0004, approved F0 screen map, REQ-004 / REQ-007, issues #13 / #23 / #24 / #27.

## Observed defects (Chrome screenshots, 320 / 375 / 1280 px)

1. **Role leakage after booking:** Client receipt's primary CTA is `Посмотреть в календаре`, jumping directly into the owner's operational Calendar. An actual guest must never receive business navigation or owner permissions from this action.
2. **Role leakage when no catalog exists:** the public booking page displays `Продолжить настройку`, redirecting the customer to owner service/staff/schedule setup.
3. **Visual bleed:** the completion panel uses the platform's Cookie heading instead of identifying the visit as the salon's booking surface; a selected salon color theme fails to carry through to the final step.

## Design implementation

### Customer public page (demo)

- When a business has no service, staff or schedule in the synthetic workspace, show a clear customer-facing *booking unavailable* state **instead of** an unusable booking form and hidden owner setup CTA.
- After synthetic booking, show a receipt and a single primary customer action: `Ещё одна демо-запись`. Do not expose or link to owner Calendar from client-facing success.
- Remove the prominent `COOKIE / ДЕМО-ЗАПИСЬ` platform marque from the confirmation body. Keep one discreet Cookie attribution in the public footer.
- Apply the already approved salon preview color palette to the confirmation surface as well as the booking page.
- In **mock mode only**, the explicitly marked top demo notice continues to offer `Вернуться в тестовый кабинет` for developers testing the admin flow. This never implies actual authentication, data isolation or client authorization.

### Deliberately not implemented

- Guest identity/proof or real authentication; confidential booking links; customer profile, history, reschedule or cancel; real API booking; publishing the page; real Telegram Mini App/iframe; production payment or contacts.
- Do not pretend client booking manages actual confirmed appointments; synthetic success states must explicitly tell customers that no server reservation exists.
- No role switcher that pretends to enforce permissions.

## Acceptance

1. With no configured service/staff/schedule, booking shows one descriptive unavailable state and **no** `Продолжить настройку`, owner action or broken form.
2. With configured fixtures, create mock booking: receipt has **no** link to business Calendar or workspace. Main action offers another synthetic booking; footer still credits Cookie quietly.
3. An explicit demo notice can be used by the test harness to return to owner workspace, where the staff calendar remains available separately.
4. A previously saved salon preview theme persists in the completion screen; matching text/contrast is maintained.
5. Existing 320 / 375 / 1280 browser smoke + unit / integration tests pass on exact feature HEAD. Review fresh screenshots, not prior iteration evidence.

## Future

Real public success UX requires a guest-scoped `ManageBooking` proof and server receipt: only after #18/#22/#23 contracts, validation of ownership/tenant and negative tests. Never substitute the owner Calendar link for a guest's booking detail page.
