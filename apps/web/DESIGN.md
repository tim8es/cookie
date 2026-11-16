# Cookie · visual system 02

**Mode:** Operate. Salon owner performs daily operations; customer selects a service, day, and hour. This frontend is synthetic and must never suggest a server reservation has happened.

**Direction:** *Studio Appointment Journal*. Instead of SaaS cards and a generic sage-green dashboard, the client appointment looks like a carefully typeset studio pass. The owner workspace is a dense, calm utility surface. The same identity joins them without identical layouts.

## Visual language

- **Aubergine** `#3D2A48`: one large editorial field and the owner rail, not every button's highlight.
- **Paper** `#F7F6F8` and **white** `#FFFFFF`: content stays readable, form fields stay native.
- **Lime** `#E0F2A5`: small four-petal brand signature and focused active states, never a fluorescent page background.
- **Ink** `#28222E` / **muted orchid** `#75687A`: content hierarchy; ensure text contrast.
- **Geometry:** 12–16px radius for major sheets, 8–9px for controls, no nested ghost cards.
- **Typography:** system sans for operational UI; a restrained book-face for the editorial first-view sentence. Avoid decorative small all-caps eyebrows and unnecessary serial numbers.
- **Motion:** meaningful response only, with `prefers-reduced-motion` support.
- **Imagery:** geometry conveys the studio motif, not stock photos or fabricated customer imagery.

## Core patterns

1. **First run:** independent two-page studio cover + native form, without the owner sidebar or QA topbar. **Owner workspace:** compact purple tool rail on desktop; horizontally scrollable navigation on narrow screens; functional active page signal. A unified metric ledger replaces four equal marketing-style cards. No bogus analytics or business claims.
2. **Client appointment:** separate header and one controlled three-stage form. A single dark editorial introduction offers context. The companion appointment pass is the signature material.
3. **Ticket / summary:** selected service and duration, staff, date, time, and **catalog base price only**. Always state that backend must confirm final price and slot.
4. **Mobile:** one main column, a reduced introduction, natural field order and no document-level horizontal scroll at CSS widths 375 and 320 pixels.
5. **Accessibility:** visible focus, proper form labels, keyboard dialog loop, no false external network calls in mock mode.
6. **Libraries:** shadcn-svelte and Bits UI source components from `src/lib/components/ui`, Lucide icons. The new shell/form uses them; legacy owner forms are migrated separately.

## What is explicitly not designed or claimed

No production sign-in, live client data, payments, backend availability, discounts, or real bookings. Synthetic values in browser test artifacts are illustrative only. UI-only progress does not authorize a production pilot.

## Visual verification

The repository F1 workflow saves Chromium screenshots at 1280×800, 375×812, and 320×568. It covers the onboarding, public booking, local confirmation, week/day calendar, details dialog, **the four owner editor forms, and restored owner workspace**. Manual device review remains necessary.

## UX iteration 2026-11-16 (design review, pending owner acceptance)

- Salon name is primary on the public page; Cookie becomes a small platform credit.
- Booking has an honest single-form description (no static fake step progress), base-price preview and branch/address in the receipt.
- Mobile owner shell uses a four-destination bottom navigation with a secondary-section sheet.
- Existing synthetic bookings can be viewed on a day-by-staff/time grid on desktop; narrow screens keep a readable list. This **does not** compute available slots.
- `?surface=telegram-preview` provides a presentation-only compact shell. It is not a functional Telegram Mini App.
- Physical-device, screen-reader, real API/Telegram and visual owner approval are still required.
