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
| Owner dashboard and stats | `src/styles/ledger.css`; `src/lib/ui/OwnerOverview.svelte` |
| Owner editor forms (services, staff, schedule, branches) | `src/styles/owner-forms.css`; `src/lib/ui/OwnerFormHeader.svelte` and the four `*Form.svelte` components |
| Calendar, week/day view, booking details dialog | `src/styles/calendar.css`; `src/lib/ui/CalendarView.svelte`, `BookingDetail.svelte` |
| Narrow-screen behavior | `src/styles/responsive.css` and narrowly scoped screen rules |
| Generic accessible Button, Input, Card, Badge, Dialog | `src/lib/components/ui/` (version-controlled shadcn-svelte sources) |
| Data/state, navigation and synthetic API operations | `src/App.svelte` and `src/lib/api.ts` (do not invent backend wire contracts) |

`src/visual-system.css` is a deliberately short ordered CSS entrypoint. **Do not add selectors there**; it exists only to import the modules. Tokens load first. The remaining `src/styles.css` contains the old owner-form/calendar baseline; it is retained for compatibility and is **not a place for new visual overrides**. When migrating another screen, move its styles into a dedicated module and verify screenshots before deleting its legacy CSS.

## Component ownership

- `App.svelte`: state and orchestration only. It calls the adapter; routes between screens and passes typed values/callbacks.
- `OnboardingScreen.svelte`: presentation. Parent owns the organization input value and submit effect.
- `OwnerOverview.svelte`: display only. Parent owns navigation, snapshot and date.
- `BookingForm.svelte`: controlled fields, slot choice, submit callback. It never performs a network call.
- `OwnerFormHeader.svelte`: shared presentational heading for the four owner editor forms. `ServiceForm`, `StaffForm`, `ScheduleForm`, `LocationForm` reuse Card/Button/Input where appropriate and keep native select controls for keyboard/mobile affordances.
- `BookingSummary.svelte`: presentation only, uses catalog base price **not** a price quote.
- `CalendarView.svelte`: week/day selection, period navigation and local booking details through Button/Card/Badge. The week region scrolls horizontally and is keyboard-focusable on narrow screens.
- `BookingDetail.svelte`: shared Card/Button/Badge in a contained synthetic details panel. Its existing two-action focus trap, Escape close and focus return remain verified by Chromium; a future full Bits UI dialog migration requires dedicated screen-reader QA.
- `src/lib/components/ui`: reusable component primitives from a maintained source registry. Prefer reusing their props and classes to adding one-off buttons/cards. Review generated code and keep the lockfile frozen.

Use explicit, typed props and callbacks across screen boundaries. Do not import the API adapter from display components. Avoid duplicating a color or radius inside another screen; add semantic tokens when it will be reused. Component-specific values should stay in that component's CSS module.

## Workflow for future AI agents

1. Read `DESIGN.md` and this guide. Find the **one** presentation component and CSS module matching the screen.
2. Modify that component and its tokens; do not append more rules to `styles.css` or reintroduce a giant `App.svelte` view.
3. Run `pnpm install --frozen-lockfile`, `pnpm check:ui`, `pnpm --filter @cookie/web check`, `pnpm --filter @cookie/web build`.
4. Run `node apps/web/scripts/browser-smoke.mjs` (uses built dist, Chrome/Chromium), review full screenshots from 1280×800, 375×812 and 320×568.
5. Pay particular attention to mobile overflow, readable form labels, focus restore, 33 synthetic screenshot states, browser-local data and the absence of external requests.
6. Add an isolated Draft PR, stacked on the previous frontend feature branch. **No merging without owner approval.**

### Non-negotiable product boundaries
All demo data is synthetic and browser-local. "Demo-confirmed" is not a real server reservation, catalog base price is not a final quote, and there is no production auth/permission enforcement. Backend contracts are reviewed separately; never invent them in UI.
