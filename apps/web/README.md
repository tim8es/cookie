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

Navigation is non-linear: services, staff, schedule, locations and calendar are also available from the menu. The dashboard guides the initial steps.

**Persistence:** browser `sessionStorage` only (key `cookie.frontend-demo.v1`). Refresh within the same tab retains demo data. Closing the tab or selecting "Сбросить демо-данные" clears them. No real personal data, logins, phone numbers, emails, payments, network writes or reservations.

**Synthetic slot semantics:** 10:00, 12:00 and 15:00 are fixture suggestions filtered to demo weekday/hour settings; they are **not calculated availability**. The fake adapter can demonstrate a same-slot collision in its own session. A scenario selector also previews loading/error/empty/forbidden and forced slot conflict UI. This does not enforce a real booking rule or role permission. All confirmed-looking records are explicitly labeled **демо**, never real backend Confirmed.

## Folder ownership / layering

- `src/App.svelte`: business shell, screens and client flow presentation.
- `src/styles.css`: global design tokens, responsive design and component classes.
- `src/lib/model.ts`: **frontend view models only**, not official wire types.
- `src/lib/api.ts`: typed port and adapter selection. Production adapter deliberately fails closed until review.
- `src/lib/mock.ts`: strictly synthetic browser-local data adapter.
- `src/lib/dates.ts`: display-only calendar date/format helpers.
- `src/lib/mock.test.ts`: mock/onboarding regression smoke tests.

No imports of backend internals, domain booking rules, kernel code, database packages or shared contracts. The same booking screen is intended for public web, iframe and Mini App shells per ADR-0005, but embed messaging, origin checks and Telegram auth are **not implemented** and must not be claimed complete.

## Tests

```sh
pnpm --filter @cookie/web test
pnpm typecheck:web
pnpm build:web
```

Repo-wide `pnpm lint`, `pnpm format:check` and GitHub F1 quality gate remain applicable.

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
