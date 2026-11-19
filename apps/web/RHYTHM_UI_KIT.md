# kuki — Rhythm UI Kit, D6 candidate 1.0 RC

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
| AccountMenu | A single account chooser, composed from Modal, ChoiceRow, Avatar and ActionButton; caller owns authenticated membership, switching and logout. |
| ChoiceList | Repeated ChoiceRow and EmptyState; caller supplies already filtered and eligible options. |
| PublicHeader | Salon identity and caller-provided actions. |
| SalonPage | Shared hero, compact/split/cover layout, real document order of staff/services, RecordRow and explicit actions. |
| BookingLayout | Shared presentation shell, step navigation, summary and next action for web/embed/telegram/manual. Caller supplies current step and allowed transitions. |
| SlotGrid | Server-projected options; no availability calculation. |
| DateStrip | Supplied day labels and enabled options; horizontal region on narrow screens. |
| ResourceDay | Grouped resource/day visit list, reuses VisitRow. Not a time-grid or availability engine. |
| ScheduleRow | Display-only shift row based on RecordRow and ActionButton. |
| MetricStrip | Exactly three equally sized metrics with per-context collapse state in browser localStorage; caller supplies a stable tenant/role/page-scoped key. Values are display strings, never computed in presentation. |
| PopoverMenu | Shared branch/filter menu with selected ID and callback; parent controls routing, filtering and accessible options. |
| ModuleSettings | Controlled set of available modules and asynchronous callback. Server must persist actual module state and enforce RBAC/entitlement/tenant checks; component only provides visual switches. |

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
Do not deploy the catalog. The existing F1 workflow runs an early isolated UI-kit gate and uploads the compiled review app and screenshots separately; no second workflow. Existing F1 checks remain required. Run catalog
build and manual browser review at 320, 375, 768 and 1280 px; inspect all
five palette scopes, keyboard navigation, pointer states and form labels.
The token tests are automatic via the existing web test command. The compiled catalog has a separate Chromium smoke using the existing CDP harness: 5 scopes × 4 widths × 9 sections, selection, save/busy, file preview/remove, errors, basic keyboard navigation, canvas inheritance, shared navigation selection, three modal layouts, theme portal and focus restoration, a complete synthetic four-step booking composition, shared channel shells, account switch callback, day selection, no external requests. It runs in the early ui_kit gate; evidence and the compiled catalog are uploaded separately. Run after building: node apps/web/scripts/rhythm-catalog-smoke.mjs. The whole isolated gate is bash scripts/ci/f1-gates.sh ui_kit. They
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
- The full time-grid calendar, tenant appearance adapter, Storybook, screenshot baseline comparison and production screen adoption remain open. The candidate must pass compiled catalog smoke and visual review.

CI, real build, visual browser screenshots and owner acceptance are distinct
gates. Do not mark this library fully ready until verified and integrated.

## One public import and composition recipes

Application code adopting Rhythm imports from `$lib/components/rhythm/index.js`.
Internal components such as RowContent are deliberately not part of the
public API. Do not import internal files from feature screens.

```svelte
<script lang="ts">
  import {
    ThemeScope,
    EntityEditor,
    TextField,
    type ChoiceItem,
    ChoiceList,
  } from "$lib/components/rhythm/index.js";

  let title = $state("");
  let selected = $state<string>();
  const options: ChoiceItem[] = [{ id: "example", title: "Example" }];
  function submit() {
    // Parent/controller validates and calls the authorized real API.
  }
</script>

<ThemeScope>
  <EntityEditor title="Service" onSubmit={submit} disabled={!title.trim()}>
    <TextField id="service-name" label="Name" bind:value={title} required />
    <ChoiceList title="Options" items={options} {selected}
      onSelect={(id) => (selected = id)} />
  </EntityEditor>
</ThemeScope>
```

In an existing application shell, mount the scope once around the entire
surface; do not nest a separate theme around each row or control. Only a
public tenant surface may receive its validated published appearance.
Use a parent-generated unique DOM ID per field. The example uses an
isolated fixture ID; no real data or persistence.

### Select the right abstraction

| Need | Use |
| --- | --- |
| Primary, secondary or destructive action | ActionButton, not raw class combinations |
| Editable field, errors, label and hint | TextField or ImageAssetField |
| Mutually exclusive filter | Segment |
| Multi-select assignments | CheckGroup |
| Service/staff/location choice | ChoiceList / ChoiceRow |
| Person or catalogue record | RecordRow, internal RowContent |
| Any visit list or day feed | VisitRow / ResourceDay |
| Detail overlay | Modal, with layout variant; not three implementations |
| Account selection | AccountMenu once per shell |
| Public identity and page | PublicHeader / SalonPage |
| Booking across channels | BookingLayout / ChoiceList / DateStrip / SlotGrid / BookingTicket |
| Three KPIs everywhere | MetricStrip (exact same dimensions/structure in each screen) |
| Branch/owner popover | PopoverMenu (not native unstyled select variations) |
| Optional feature switches | ModuleSettings (server-authoritative modules only) |

Each feature owns data fetching, authorization, validation and mutation
results. Components own visual semantics, keyboard interaction and
presentation. For a new visual state, extend the existing component's
typed variant contract, add a catalog story and tests. Do not introduce
feature-specific copies, raw hex colors, inline styles or arbitrary CSS
overrides. Do not introduce new primitive libraries. An exception requires
a documented reason and a review of the shared component first.

### Change checklist

1. Locate the component in the table above and reproduce the issue in its
   actual Svelte catalog story.
2. Change the shared source and owning token/rule, not the catalog markup
   or a calling feature alone.
3. Run existing project checks plus isolated catalog smoke, and inspect
   the desktop/mobile evidence for every affected palette/state.
4. Keep screenshots tied to the exact tested commit. Do not substitute
   source-level palette checks or HTML-concept screenshots for actual
   Svelte render evidence.
5. Obtain visual review and verify the real API/runtime slice separately
   before migrating it. No production activation in this PR.

## Consistency and modularity acceptance — RC8 owner feedback

The owner flagged duplicated heading stacks, inconsistent KPI widget height
and cell arrangement, implementation jargon on customer-facing screens and
unstyled branch dropdowns. The HTML reference was corrected in RC8; this
Svelte PR now owns the same components as **candidates**, without silently
changing the real application’s accepted design or runtime.

- MetricStrip provides one three-column contract for overview, calendar,
  customers, offers and analytics. Same padding and typography on every
  screen. It can collapse in place with an immediately available toggle.
  Browser preference keys MUST include organization ID, role and screen,
  for example `kuki.metricStrip.<organizationId>.<role>.<screenId>`.
  Never persist customer data or permissions in localStorage.
- Keep exactly one meaningful page title. Context labels are optional,
  and captions must not repeat the title. Product-facing text must not
  contain requirement IDs, internal RBAC explanations, fixture limitations,
  debug notes or developer terminology. Synthetic data in QA may retain
  a small, separate non-misleading demo badge.
- Use PopoverMenu rather than separate branch-select implementations.
  Adapt its keyboard/pointer, overflow and focus behavior across mobile
  and embedded surfaces.
- ModuleSettings is controlled presentation. REQ-019 requires enabling or
  disabling an already installed business module **without restarting**
  the application, by an authorized owner with durable server-persisted
  tenant state, audit, entitlements, and server-side permission checks.
  If a module is disabled, its navigation and entrypoints are absent,
  and its actual server commands are denied; CSS hiding is never enough.
  Verify changes in every channel (web, widget, Telegram) and in
  concurrent sessions. Re-enable without losing historical data.
  **Do not disable** foundation booking, access controls, existing visit
  management, export after trial expiry (REQ-063), or other fixed core
  invariants. Trial and plan restrictions cannot be overridden via the UI.
- This PR has *no* installed-module registry or authorization backend and
  must NOT claim REQ-019 implementation. The HTML demo's localStorage
  toggles are illustrative only. Backend entitlement implementation and
  cross-channel negative tests belong to their own F2 work.

## Release gates

D6 component implementation and visual review are separate from the F1
real runtime acceptance. Before merging, check the exact latest PR head:
format, Svelte check, compiled catalog, browser matrix, screenshots across
375/1280 px and all themes, module and popover keyboard behavior, then
review with the owner. Build a vertical slice of a real page using these
components after acceptance; do not deploy publicly or turn off real
features from a browser-only preference.
