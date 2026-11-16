# Cookie web — F1 interactive frontend foundation

Existing workspace: `apps/web`. Svelte 5, TypeScript and Vite. No second application, no SSR or production deployment.

## Local run

From repository root with Node.js 26 and pnpm 10.24.0:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev:web
```

Open **http://127.0.0.1:5173/**. Mock mode is the default. To be explicit:

```sh
VITE_COOKIE_DATA_MODE=mock pnpm dev:web
```

On Windows PowerShell: `$env:VITE_COOKIE_DATA_MODE='mock'; pnpm dev:web`.

To verify the *fail-closed* API adapter (no invented endpoints):

```sh
VITE_COOKIE_DATA_MODE=api pnpm dev:web
```

This shows the "API not connected" error; it **does not** send requests to backend.

## First walkthrough

1. Open the Overview page and create a **test organization** with a synthetic name.
2. Add a service with one base price and organization-wide duration.
3. Add a staff display profile and assign the service.
4. Choose staff, location, working days and hours on Schedule.
5. Use Online booking: service → location → staff → date → fixture time → synthetic client alias → submit.
6. Open Calendar; choose day or week, click the booking card.

Navigation is non-linear: services, staff, schedule, locations and calendar are also available from the menu. The dashboard guides the initial steps. Owner forms use controlled values and callbacks; their submission still goes through the same frontend-only mock adapter.

**Persistence:** browser `sessionStorage` only (key `cookie.frontend-demo.v1`). Refresh within the same tab retains demo data. Closing the tab or selecting "Сбросить демо-данные" clears them. No real personal data, logins, phone numbers, emails, payments, network writes or reservations.

**Synthetic slot semantics:** 10:00, 12:00 and 15:00 are fixture suggestions filtered to demo weekday/hour settings; they are **not calculated availability**. The fake adapter can demonstrate a same-slot collision in its own session. A scenario selector also previews loading/error/empty/forbidden and forced slot conflict UI. This does not enforce a real booking rule or role permission. All confirmed-looking records are explicitly labeled **демо**, never real backend Confirmed.

## Design system and component ownership

The agreed visual direction is **Studio Appointment Journal**. Product
principles live in [DESIGN.md](./DESIGN.md); day-to-day modification and
agent instructions live in [UI_GUIDE.md](./UI_GUIDE.md).

**Change the tokens first:** `src/styles/tokens.css` is the canonical
source for brand colors, editorial typography, surfaces, and radii.
`src/visual-system.css` imports independent styles for the workspace,
booking flow, onboarding, responsive layouts, first-run shell and dashboard.
`src/styles.css` now only imports three historical compatibility layers in
`src/styles/compat/{base,workspace,public}.css`. Their combined size is capped
by `check:ui`; it must decrease as selectors are migrated to screen modules.
Two outdated palette roots and 59 dead rules were removed earlier; do not
reintroduce them or append new presentation rules to these layers.
The week/day calendar and booking details are styled in `src/styles/calendar.css`
and reuse Card/Button/Badge primitives. On narrow screens, the week is
keyboard-scrollable within its own region rather than overflowing the page.

**Change the screen only:** `src/lib/ui/OnboardingScreen.svelte`,
`OwnerOverview.svelte`, `BookingForm.svelte`, `BookingSummary.svelte`,
`CalendarView.svelte` and the owner forms contain screen presentation.
`App.svelte` orchestrates state and synthetic adapter actions. The four owner
list+editor pages now live in standalone `Owner*Page.svelte` files and the
confirmation/feedback flow in `BookingConfirmation.svelte` and `DemoState.svelte`.

The versioned `shadcn-svelte` components in `src/lib/components/ui/`
provide accessible Button/Card/Input/Badge/Dialog/Label/Separator primitives,
using Bits UI, Tailwind v4 and Lucide. Keep native service/staff/location
selects unless there is a clear reason to replace them. A new component
should use existing tokens and typed props/callbacks rather than importing
the API from a presentation file.

Before requesting design approval run `pnpm check:ui`,
`pnpm --filter @cookie/web check`, `pnpm --filter @cookie/web build` and
the 39-screenshot Chromium browser smoke across desktop and mobile.

## Folder ownership / layering

- `src/App.svelte`: shared UI state/orchestration across owner and public flows (no backend rules), with versioned slot-request guard against stale responses.
- `src/lib/navigation.ts`: typed, shared screen navigation metadata.
- `src/lib/ui/Sidebar.svelte`: owner navigation with accessible onboarding progress.
- `src/lib/ui/Topbar.svelte`: demo-mode ribbon, workspace controls and preview states.
- `src/lib/ui/BookingSummary.svelte`: reusable client-side display of *catalog base price*, never Quote.
- `src/lib/ui/BookingForm.svelte`: controlled public form (callbacks receive the newly selected value, avoiding event/binding order races).
- `src/lib/ui/ServiceForm.svelte`: owner service/catalog input, without pricing calculations.
- `src/lib/ui/StaffForm.svelte`: owner staff-profile input and service assignment selector, without access-policy logic.
- `src/lib/ui/ScheduleForm.svelte`: owner weekday/time template input, without availability enforcement.
- `src/lib/ui/LocationForm.svelte`: synthetic branch name/address input.
- `src/lib/weekdays.ts`: shared UI weekday names and JavaScript day-number convention.
- `src/lib/ui/BookingDetail.svelte`: booking drawer with keyboard Escape, initial focus, Tab loop and focus restoration.
- `src/lib/ui/CalendarView.svelte`: standalone day/week calendar, date navigation and keyboard-selectable booking details.
- `src/lib/calendar.ts`: pure presentation selector for date-based and deterministic chronological ordering.
- `src/styles/tokens.css`: canonical tokens; `src/styles/compat/`: temporary
legacy cascade modules that must shrink; `src/styles/*.css`: maintained
visual styling, by owning screen.
- `src/lib/model.ts`: **frontend view models only**, not official wire types.
- `src/lib/api.ts`: typed port and adapter selection. Production adapter deliberately fails closed until review.
- `src/lib/mock.ts`: strictly synthetic browser-local data adapter.
- `src/lib/dates.ts`: display-only calendar date/format helpers.
- `src/lib/mock.test.ts`: mock/onboarding regression smoke tests.
- `src/lib/api.test.ts`: fail-closed API mode regression.
- `src/lib/dates.test.ts`: timezone-independent calendar day/week boundaries.
- `src/lib/navigation.test.ts`: shared owner/public navigation inventory.
- `src/lib/calendar.test.ts`: date filtering, stable ordering and no mutation of booking snapshots.
- `src/lib/weekdays.test.ts`: weekday numbering and unique selectors.

No imports of backend internals, domain booking rules, kernel code, database packages or shared contracts. The same booking screen is intended for public web, iframe and Mini App shells per ADR-0005, but embed messaging, origin checks and Telegram auth are **not implemented** and must not be claimed complete.

## Tests

```sh
pnpm --filter @cookie/web test
pnpm typecheck:web
pnpm build:web
```

Repo-wide `pnpm lint`, `pnpm format:check` and GitHub F1 quality gate remain applicable.


## Manual UX checks for review (not yet verified on physical devices)

- Desktop 1280×800: create the synthetic salon; add a service and staff; configure workdays; select a suggested slot; submit and verify the record in the day/week calendar.
- Mobile 375×812 and 320×568: repeat the full flow, including keyboard/date picker and horizontal week scroll. Check no controls are clipped or obstructed.
- Keyboard: Tab through owner navigation and booking form; open a calendar record with Enter; drawer must focus its close control, cycle focus between dialog buttons and close on Escape, returning focus to the invoking control.
- Preview selector: empty, error, permission-denied and forced slot conflict are visual fixtures only. Real authorization remains API-enforced.
- Reload page in same tab to verify synthetic state restoration; use Reset demo to clear it. Opening an independent browser session must not share state.
- API mode: run with `VITE_COOKIE_DATA_MODE=api`; verify **only** the explicit disconnected error is shown, no fake success or network request.

**Important:** GitHub CI does not replace physical device or browser visual QA. Do not close the mobile UX portion of Issue #13 solely from typecheck/CI.

## Automated Chromium browser smoke (CI)

The repository F1 workflow runs `node apps/web/scripts/browser-smoke.mjs`
**after** `pnpm --filter @cookie/web build`, using a headless Chrome/Chromium
binary already installed on the GitHub Ubuntu runner. Node.js 26 provides the
native WebSocket client for Chrome DevTools; no Playwright, extra npm packages
or remote browser provider are required.

To execute locally, run `pnpm build:web`, then
`node apps/web/scripts/browser-smoke.mjs`; install Chrome/Chromium if absent,
or set `COOKIE_BROWSER_BINARY` to its executable path.

The smoke test serves the Vite-built `dist/` with a minimal Node HTTP server on a random **loopback-only** port, drives an
isolated browser session, and checks 1280×800, 375×812 and 320×568 viewports:
synthetic salon → service → staff → weekly schedule → slot → demo booking →
week/day calendar → booking drawer and Escape focus restoration → reload
persistence → error/forbidden previews → reset. It fails if the whole document
overflows the viewport; the calendar's intentionally scrollable internal week
grid is allowed.

The CI browser test also captures **18 Chromium screenshots** (six UI milestones
at each of the three viewports) and a `manifest.json` in
`apps/web/artifacts/visual-smoke/`. The workflow attaches these to the
`cookie-frontend-visual-smoke` Actions artifact for **seven days**, even if a
later stage fails. Screenshots use only synthetic names/data. The test also asserts **exact CSS layout widths** (`innerWidth ===
1280/375/320`) and no document-level horizontal overflow; its screenshot
clip is constrained to the real viewport (unlike Chromium's default
`captureBeyondViewport` capture, which may include off-screen scrollable
children). This is narrow-viewport responsive testing, **not** native
touch-device emulation.

The test also
asserts that all visible interactive controls have a label, dialog Tab and
Shift+Tab wrap correctly, Escape returns focus, and the page makes **no
external HTTP(S) requests** in mock mode. These are scoped automated checks,
not a full WCAG audit. Review the actual PNGs before claiming visual QA done.

This is a real Chromium DOM/keyboard test on synthetic browser-local data,
**not** production backend E2E, cross-browser coverage, touch-device
verification, pixel-level visual QA, payment testing or authorization testing.
The browser only accesses a locally served frontend. No external network,
customer records or booking-provider calls are required.

## Single client across web, mobile web and Telegram Mini App

The client booking screen is **one Svelte flow**, not three independently
maintained products. Web desktop, mobile browser and Telegram WebView use the
same UI components and the same future Booking API adapter. The desktop and
320/375px Chromium smoke tests are the current regression baseline; they do
not establish real iOS, Android or Telegram client compatibility.

- **Browser / mobile browser:** native forms, keyboard navigation, responsive
  column layout, document overflow checks, and CSS safe-area insets.
- **Telegram Mini App:** the *same* public booking components adapt to the
  Telegram bridge's safe-area/content-safe-area CSS variables when available.
  A synthetic Chromium test sets those variables at 320/375px; there is no
  Telegram SDK, bot, launch/session exchange or real Mini App runtime in F1.
- **Trust boundary:** neither a Telegram user object nor raw `initData`
  is proof of identity inside the browser. Backend must specify and verify
  launch data/session/auth transport in #66 before any API-mode booking.
  Browser login must not depend on Telegram. No WebView host may directly
  calculate price, authorize staff, or mark a booking Confirmed.

The contract-neutral `src/lib/transport.ts` has an explicitly injected
fetch implementation, classifies generic HTTP failures and never retries
unsafe requests on its own. Its response remains `unknown` until a reviewed
OpenAPI/JSON Schema mapper exists. `api.ts` continues to fail closed in API
mode; mock mode remains network-isolated.

**Acceptance still outstanding:** iOS Safari and Android Chrome physical
device checks, Telegram iOS/Android/Desktop launch and keyboard/viewport
behavior, Telegram BackButton/theme integration, verified server-side
`initData` and per-channel session handling, real Booking API contract tests.

## Required reviewed APIs (#22/#23/#26)

These are **integration needs**, not proposed HTTP endpoint names or wire schemas:

| UI capability | Server responsibility |
| --- | --- |
| Organization creation / bootstrap | Authenticated Organization onboarding, tenant identity and trial state |
| Business workspace read | Allowed Organization, Location and role-scoped current profile |
| Services and prices | Tenant-scoped Service CRUD, base-price/branch/staff override reads, policy and validation |
| Staff | StaffProfile/role/scope assignments, service associations and entitlements |
| Schedules | Staff × Location schedule commands, holidays and conflicts, authorization |
| Business calendar | Day/week Booking list, details, customer-data redaction, permitted state transitions |
| Public catalog & slots | Location/staff-filtered catalog, server availability and Quote |
| Create booking | Verified identity, idempotency, authoritative price/discounts, atomic Confirmed or domain conflict |
| Future cancel/reschedule | Server-side policy/deadlines, actor scope, preservation of historical price for time-only reschedule |

Before integrating API: approve OpenAPI/JSON Schema DTOs, auth/session transport, tenant and location context, time zone/UTC presentation, pagination/filtering, error/status taxonomy (`BOOKING_CONFLICT`, authZ, trial/entitlement errors), Quote and Confirmed response mapping. This first PR adds **no** speculative backend contract.

## Explicitly outside this PR

Business logic or authoritative availability, pricing resolution, discount handling, access control, payment/trial gating, real notifications, real customer identity, booking mutation/cancellation, iframe or Telegram trusted shells, production readiness, launch deployment and performance benchmarking. Issue #13 device/a11y acceptance and Issues #22/#23/#24/#26 integration acceptance remain open.

## Telegram Mini App — UI preview only

Use `?surface=telegram-preview` on the local demo URL, finish the synthetic salon setup, and open **Онлайн-запись** to inspect a compact Mini App-style booking surface. It reuses the same BookingForm/BookingSummary as public web, without separate business rules.

**Not a Telegram integration:** No SDK calls, native BackButton/MainButton, verified `initData`, theme synchronization, Telegram authentication, bot launch, or real bookings. Those require a separate F2 implementation, platform/WebView and device testing, and the existing security gates. The query parameter must never be treated as an authentication or trusted platform signal.
