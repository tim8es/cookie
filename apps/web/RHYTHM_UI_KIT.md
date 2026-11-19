# kuki — Rhythm UI Kit, D6 candidate 0.3

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
| ActionButton | Shared Button composition: secondary, primary, danger; native type and disabled/busy handling. |
| CheckGroup | Controlled IDs; native labelled checkboxes, no assignment rules. |
| Notice | Feedback with text status/alert and optional recovery action snippet. |
| ImageAssetField | Local input and parent-provided preview/error/busy; caller handles validation, URL lifetime and asset upload. |
| Modal | Existing Bits UI Dialog with dialog/sheet/drawer layout, labelled trigger, content/actions snippets and bindable open. Portal into nearest ThemeScope (no transformed/clipped scope ancestors); Escape/focus owned by Bits UI. |
| Navigation | Controlled current page and caller-filtered items; rail/bar variants, same active state. Does not implement routing or authorize access. |

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
The token tests are automatic via the existing web test command. The compiled catalog has a separate Chromium smoke using the existing CDP harness: 5 scopes × 4 widths × 5 sections, selection, save/busy, file preview/remove, errors, basic keyboard navigation, canvas inheritance, shared navigation selection, three modal layouts, theme portal and focus restoration, no external requests. It runs in the existing browser gate; evidence is uploaded separately. Run after building: node apps/web/scripts/rhythm-catalog-smoke.mjs. They
verify declared palette pairs and catalog canvas inheritance, not pixel
contrast, screen readers, or visual regression.

## Rules for integration

- No business rules in presentation, no direct API access, no hardcoded
  tenant policies, no authorization inferred from hidden actions.
- Published appearance values must come from the existing validated server
  contract. These CSS presets are reference samples for the catalog only.
  Do not promote them to a second runtime theme source.
- ThemeScope must wrap the entire public canvas. Modal portals into its closest ThemeScope. Keep that scope free of transforms and clipping; test focus, colors and clipping in host layouts before adopting.
- Refactor actual screens by bounded vertical slices after review.
  Do not insert old prototype CSS or rewrite runtime authentication.
- Additional variants, account menu, shared salon/booking shell, schedule and calendar patterns, Storybook and visual regression baselines remain open. The dialog/sheet/drawer candidates and navigation must pass compiled catalog smoke.

CI, real build, visual browser screenshots and owner acceptance are distinct
gates. Do not mark this library fully ready until verified and integrated.
