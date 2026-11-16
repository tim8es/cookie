# Cookie UI: how to change the design safely

## Approved direction
**Studio Appointment Journal** is approved as the current visual direction, not as final screen sign-off. Do not independently replace it with a new color theme or generic dashboard design. [DESIGN.md](./DESIGN.md) describes the visual intent.

## Single places to edit

| You want to change | Canonical source |
| --- | --- |
| Backgrounds, brand colors, UI font, editorial font, radii | `src/styles/tokens.css` |
| Public appointment layout and appointment-pass style | `src/styles/booking.css`; `src/lib/ui/BookingForm.svelte`, `BookingSummary.svelte`, `PublicHeader.svelte` |
| First-run split hero and form | `src/styles/onboarding.css`, `src/styles/first-run.css`, `src/lib/ui/OnboardingScreen.svelte` |
| Owner shell, sidebar, topbar, shared UI helpers | `src/styles/foundation.css`; `src/lib/ui/Sidebar.svelte`, `Topbar.svelte` |
| Owner page composition (lists + editor) | `src/lib/ui/OwnerServicesPage.svelte`, `OwnerStaffPage.svelte`, `OwnerSchedulePage.svelte`, `OwnerLocationsPage.svelte`; form styles in `styles/owner-forms.css` |
| Public booking masthead, setup hint | `src/lib/ui/PublicBookingHero.svelte`, `BookingSetupHint.svelte`; styles in `src/styles/booking.css` |
| Global notices and footer | `src/lib/ui/DemoNotices.svelte`, `DemoFooter.svelte`; structural legacy rules in compat until migrated |
| Confirmation & demo UI states | `src/styles/feedback.css`, `src/lib/ui/BookingConfirmation.svelte`, `DemoState.svelte` |
| Owner dashboard and stats | `src/styles/ledger.css`; `src/lib/ui/OwnerOverview.svelte` |
| Owner editor forms (services, staff, schedule, branches) | `src/styles/owner-forms.css`; `src/lib/ui/OwnerFormHeader.svelte` and the four `*Form.svelte` components |
| Calendar, week/day view, booking details dialog | `src/styles/calendar.css`; `src/lib/ui/CalendarView.svelte`, `BookingDetail.svelte` |
| Narrow-screen behavior | `src/styles/responsive.css` and narrowly scoped screen rules |
| Generic accessible Button, Input, Card, Badge, Dialog | `src/lib/components/ui/` (version-controlled shadcn-svelte sources) |
| Data/state, navigation and synthetic API operations | `src/App.svelte` and `src/lib/api.ts` (do not invent backend wire contracts) |

`src/visual-system.css` is a deliberately short ordered CSS entrypoint. **Do not add selectors there**; it exists only to import the modules. Tokens load first. `src/styles.css` is now an **import-only entrypoint** for the historical cascade in `src/styles/compat/{base,workspace,public}.css`. The three modules are a temporary migration boundary, *not* a place for new UI. Their combined size is capped at **35 591 bytes** by `pnpm check:ui`; edits must reduce them by moving currently used rules into the appropriate screen module while maintaining the import order. Move any remaining required selectors to their owning modular stylesheet when a screen changes. When migrating another screen, move its styles into a dedicated module and verify screenshots before deleting its legacy CSS.

## Component ownership

- `App.svelte`: state and orchestration only. It calls the adapter; routes between screens and passes typed values/callbacks.
- `OnboardingScreen.svelte`: presentation. Parent owns the organization input value and submit effect.
- `OwnerOverview.svelte`: display only. Parent owns navigation, snapshot and date.
- `OwnerServicesPage`, `OwnerStaffPage`, `OwnerSchedulePage`, `OwnerLocationsPage`: each owns its list and editor composition. A single App keeps the corresponding state and passes callbacks.
- `BookingConfirmation.svelte`, `DemoState.svelte`: presentation-only success, error, empty, forbidden and setup outcomes; final booking confirmation remains on the backend.
- `PublicBookingHero.svelte`, `BookingSetupHint.svelte`, `DemoNotices.svelte`, `DemoFooter.svelte`: shell views/controls, no adapter ownership; App passes explicit callbacks.
- `BookingForm.svelte`: controlled fields, slot choice, submit callback. It never performs a network call.
- `OwnerFormHeader.svelte`: shared presentational heading for the four owner editor forms. `ServiceForm`, `StaffForm`, `ScheduleForm`, `LocationForm` reuse Card/Button/Input where appropriate and keep native select controls for keyboard/mobile affordances.
- `BookingSummary.svelte`: presentation only, uses catalog base price **not** a price quote.
- `CalendarView.svelte`: week/day selection, period navigation and local booking details through Button/Card/Badge. The week region scrolls horizontally and is keyboard-focusable on narrow screens.
- `BookingDetail.svelte`: shared Card/Button/Badge in a contained synthetic details panel. Its existing two-action focus trap, Escape close and focus return remain verified by Chromium; a future full Bits UI dialog migration requires dedicated screen-reader QA.
- `src/lib/components/ui`: reusable component primitives from a maintained source registry. Prefer reusing their props and classes to adding one-off buttons/cards. Review generated code and keep the lockfile frozen.

Use explicit, typed props and callbacks across screen boundaries. Do not import the API adapter from display components. Avoid duplicating a color or radius inside another screen; add semantic tokens when it will be reused. Component-specific values should stay in that component's CSS module.

## Workflow for future AI agents

1. Read `AGENTS.md`, `DESIGN.md` and this guide. Find the **one** presentation component and CSS module matching the screen.
2. Modify that component and its tokens; do not append more rules to `styles.css` or reintroduce a giant `App.svelte` view.
3. Run `pnpm install --frozen-lockfile`, `pnpm check:ui`, `pnpm --filter @cookie/web check`, `pnpm --filter @cookie/web build`.
4. Run `node apps/web/scripts/browser-smoke.mjs` (uses built dist, Chrome/Chromium), review full screenshots from 1280×800, 375×812 and 320×568.
5. Pay particular attention to mobile overflow, readable form labels, focus restore, 39 synthetic screenshot states, browser-local data and the absence of external requests.
6. Add an isolated Draft PR, stacked on the previous frontend feature branch. **No merging without owner approval.**

### Non-negotiable product boundaries
All demo data is synthetic and browser-local. "Demo-confirmed" is not a real server reservation, catalog base price is not a final quote, and there is no production auth/permission enforcement. Backend contracts are reviewed separately; never invent them in UI.

## UX iteration branch: public booking, mobile owner, and time/resource calendar

- `PublicHeader.svelte` shows the salon as the primary identity. In production use a trusted tenant display name, never query-string branding.
- `BookingSummary.svelte` now takes a `Location` and shows address. The initial base price is only a catalog preview, not a contractual quote.
- `Sidebar.svelte` owns mobile bottom navigation; `responsive.css` owns its safe-area styles and larger inputs. Keep desktop `.nav-links` for the existing navigation inventory and agent smoke tests.
- `CalendarView.svelte` accepts `services` and `staff` for a visual staff/time layout of existing bookings; mobile remains a day list. Never turn that view into synthetic availability or editable backend actions.
- `?surface=telegram-preview` adjusts only presentation. It must not grant Telegram identity, token access, booking permissions or genuine WebApp integration.
- Chromium smoke now checks salon branding, address, base price, desktop time/resource board, and mobile navigation; physical devices still need manual review.
