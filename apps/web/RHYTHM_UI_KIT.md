# kuki — Rhythm UI Kit, D6 candidate 0.1

Status: PROPOSED, not Design Freeze. Refs #338 and #223. Visual reference:
RC7.1 interactive concept (owner review), RC6 component contracts, RC7.1 catalog
canvas correction. Existing Studio Appointment Journal production direction
remains unchanged. No production entrypoint imports the candidate.

## Ownership

Use the existing shadcn-svelte Button, Input, Badge, Dialog, and other
primitives in src/lib/components/ui. Do not fork them. Rhythm composes them
with typed props and snippets under src/lib/components/rhythm. ThemeScope
owns opt-in styling; its CSS is separate from the legacy cascade.

| Component | Contract |
| --- | --- |
| ThemeScope | Preview theme: workspace + four salon presets. No persistence or entitlement. |
| ChoiceRow | Service, staff, location choice; controlled selected and disabled, optional leading snippet and trailing copy. Same canvas as salon; selected uses accent. |
| Segment | Controlled ID, options and callback; unique IDs required from parent. |
| Avatar | Decorative image with initial fallback. Trusted resolved asset URL only; no upload or storage. |
| RecordRow | Catalogue / directory display, optional caller-owned action. |
| VisitRow | Server-projected strings, optional open callback. UI never infers permissions or status. |
| TextField | Accessible label, ID, bindable text, hint, error, native input attributes. Parent owns validation. |
| EntityEditor | Shared form and actions; parent supplies fields, save and cancel. |
| BookingTicket | Display-only lines and price label/qualification; no pricing or reservation logic. |
| EmptyState | Empty state and optional caller-owned action. |

Component catalog is a small local-only Svelte app with synthetic data,
not Storybook yet. Uses actual components, no HTML-prototype runtime, no
fake API, no network-backed behavior. A Storybook installation and lockfile
change are deliberately deferred until review of the dependency and CI cost.

## Run from repository root (Node and pnpm as pinned by repository)

```sh
pnpm install --frozen-lockfile
pnpm --filter @cookie/web check
pnpm --filter @cookie/web exec vite --config vite.ui-kit.config.mts
# open http://127.0.0.1:5173/ui-kit/
pnpm --filter @cookie/web exec vite build --config vite.ui-kit.config.mts
```

Catalog artifacts go to apps/web/.tmp/rhythm-ui-kit-dist, not runtime dist.
Do not deploy the catalog. The existing F1 web gate now builds the isolated catalog as well as the application; no second CI workflow. Existing F1 checks remain required. Run catalog
build and manual browser review at 320, 375, 768 and 1280 px; inspect all
five palette scopes, keyboard navigation, pointer states and form labels.
The token tests are automatic via the existing web test command. They
verify declared palette pairs and catalog canvas inheritance, not pixel
contrast, screen readers, or visual regression.

## Rules for integration

- No business rules in presentation, no direct API access, no hardcoded
  tenant policies, no authorization inferred from hidden actions.
- Published appearance values must come from the existing validated server
  contract. These CSS presets are reference samples for the catalog only.
  Do not promote them to a second runtime theme source.
- ThemeScope must wrap the entire public canvas. For portal components
  such as Dialog, preserve theme scope using the existing Bits UI portal
  contract and test focus, colors and clipping before adopting.
- Refactor actual screens by bounded vertical slices after review.
  Do not insert old prototype CSS or rewrite runtime authentication.
- Additional variants, image asset field, check group, navigation, shared
  salon/booking shell, schedule and calendar patterns, dialog/sheet
  composition and Storybook/visual QA gates remain open.

CI, real build, visual browser screenshots and owner acceptance are distinct
gates. Do not mark this library fully ready until verified and integrated.
