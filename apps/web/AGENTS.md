# Cookie web UI — instructions for code agents

This directory extends the repository-level `AGENTS.md`. Those product,
privacy, approval, CI and feature-branch constraints continue to apply here.

## Design source of truth

Before editing any web UI, read:
1. `DESIGN.md` — approved **Studio Appointment Journal** look and product intent.
2. `UI_GUIDE.md` — ownership of screens, components and styles.
3. `src/styles/tokens.css` — canonical palette, radius and typography tokens.

The current direction has been accepted for continued iteration, **not**
production launch or unrestricted visual redesign. Keep it consistent.

## Change boundaries

- `src/App.svelte` coordinates synthetic state, navigation and UI adapter actions.
  It must **not** accumulate new screen layouts. Split every new screen into
  `src/lib/ui/*Page.svelte` and accept typed props/callbacks.
- General controls come from maintained version-controlled shadcn-svelte
  `src/lib/components/ui/`; avoid writing custom substitute buttons/inputs.
- Screen-specific CSS lives in the named `src/styles/*.css` module.
  Reusable visual values go to `src/styles/tokens.css`.
  `src/styles.css` only imports the historical CSS layers in
  `src/styles/compat/{base,workspace,public}.css`. Those files are
  **compatibility-only**, capped by `pnpm check:ui` and must shrink over
  time; never add feature styles or old palette rules there.
- Calendar, owner forms, public booking and confirmation are separate
  presentation components. Backend price, booking availability, permissions,
  and payment logic **must not** be implemented in this UI.
- In mock mode use synthetic sessionStorage data only. Never use real names,
  phone numbers, customer data, or external service calls.

## Demo/real parity — owner requirement #311

For each released capability, prefer the same runtime, screen and domain policy in demo and real mode. `pnpm demo:local` is the disposable synthetic runtime; `/demo` remains a legacy UI test fixture during migration, not a separately released product. Do not extend it as independent business logic or use mock success as real acceptance. Preserve strict data/session isolation, fail-closed production auth and no real external effects. New changes should use the same scenarios in both modes; disclose any missing parity in the PR.

## Acceptance for any UI change

1. `pnpm install --frozen-lockfile` from the workspace root.
2. `pnpm check:ui`, `pnpm --filter @cookie/web check`,
   `pnpm --filter @cookie/web build` and existing repo tests.
3. `node apps/web/scripts/browser-smoke.mjs`: review generated Chromium
   screenshots on 1280×800, 375×812 and 320×568 CSS pixels.
4. Check no horizontal document overflow, accessible labels and focus
   behavior, and no external requests in mock mode.
5. Make a new **stacked Draft PR** on the latest frontend feature branch.
   Do not merge to `main` or claim production acceptance without owner approval.

Chrome CSS viewport simulation does not substitute for physical touch
devices or dedicated screen-reader testing.
