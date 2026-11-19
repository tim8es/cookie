# kuki — D0/D1 design foundation and delivery plan

Status: **PROPOSED / owner review**, 2026-11-18. Refs #338, #13, #23–#28, #223, #253. Baseline inspected: `e38443c6d83772041c726c79e5385bcc0f5e678c` (main).
This is a documentation/design contract proposal, not a new accepted visual identity or proof of working UI. See [screen registry](screen-registry.md).

## 1. Canon and scope
- Product requirements/decisions and [ADR-0005](../architecture/ADR-0005-shared-booking-ui.md) govern workflows, access and channel adapters. The F0 screen map is accepted; per-screen visual targets are not.
- Existing [DESIGN.md](../../apps/web/DESIGN.md), [UI_GUIDE.md](../../apps/web/UI_GUIDE.md), [web agent rules](../../apps/web/AGENTS.md) and [tokens.css](../../apps/web/src/styles/tokens.css) are the visual/engineering baseline. Studio Appointment Journal stays until a specific owner-approved change.
- Design serves 2–10-master salons first, not a generic enterprise CRM. Owner/admin/staff and customer roles get different capabilities, not independently forked applications. Customer web, iframe and Mini App share booking components. Ordinary Telegram bot uses its own conversational adapter.
- Design work runs concurrently with F1; do not block #203 for speculative F2 UX. No changes to accepted business invariants, public rollout, real PII or payments.

## 2. D0 — findings from source, not rendered audit
| Finding | Evidence | Next action |
|---|---|---|
| F0 map is conceptual, not a visual screen/state inventory | blueprint §5; #13 | stable IDs, state coverage and references in screen registry |
| Historical synthetic documentation conflicts with real runtime wording | DESIGN.md says synthetic; App.svelte imports RealOwnerWorkspace, OwnerAuthGate, StagingCustomerGate; web AGENTS.md separates fixture/runtime per #311 | verify code and render before updating historical statements, keep test-only behavior clearly identified |
| Product nav has identifiers home/calendar/services/staff/schedule/locations/appearance/booking; real routing differs | navigation.ts; RealOwnerWorkspace.svelte uses RealOwner*Page; booking branch renders unavailable page | verify entry routes, capability visibility, refresh/back and link sharing; do not count a label as a live feature |
| Client history exists as a separate staging component | StagingCustomerGate imports StagingCustomerHistory and StagingCustomerOffers | inspect actual states and verify auth/booking management; do not claim a complete public profile |
| Shared token file defines palette/radii/type, but also historical aliases (--green, --cream) and literal primitive values | tokens.css | audit computed styles and compatibility CSS, migrate only with evidence; no mass replacement |
| Onboarding and navigation descriptions include historical variants | DESIGN.md, UI_GUIDE.md, Sidebar.svelte mobile nav | compare real mobile render with intended layout |
| Auth and uncertain creation recovery are concurrent areas | open #314, #317, #320–#328, #330; #306/#307 | design specifications only; agent coordination and rebase before implementation |

**Evidence boundary:** exact baseline files read through GitHub. No runtime, screenshots, physical devices, measured performance, accessibility scanner, or visual review executed in this session. All rendered checks NOT RUN. D0 visual audit remains open. Auth stack PRs are not part of the baseline and must not be pre-counted as implemented.

## 3. D1 — proposed taste profile and visual rules
Existing direction: an appointment journal with an editorial customer surface and a calm operational workspace. Preserve useful hierarchy rather than enforce identical presentation on every role. The salon identity leads on public booking pages; kuki leads in the product workspace. First priority is task completion: enough information at the right moment, no visual decoration that competes with booking or calendar.

Reference assignments (intent, not a completed image analysis):
| Reference | Job | Transferable rule | Anti-rule |
|---|---|---|---|
| Studio Appointment Journal (existing accepted direction) | identity, typography & surfaces | restrained aubergine focal field, paper/ink, sparing lime, compact operational typography, editorial face limited to public brand moments | no arbitrary new palette or generic SaaS card grid |
| Telegram (owner reference, ADR-0005) | response and interaction | immediate pending feedback, predictable back, readable lists, low-friction touch controls | do not clone brand or assume its implementation |
| Altare.gg (owner reference, ADR-0005) | navigation & perceived speed | stable shell, quick transitions, preserve context | no visual copying or unmeasured speed claims |
| DIKIDI / YCLIENTS | domain benchmark candidate | evaluate booking calendar, availability, admin daily operations | no competitor UI borrowed verbatim; research NOT RUN |

Taste extraction after screenshots: record evidence -> observation -> transferable rule -> constraint. No source imagery analyzed this session; reference jobs are proposals. Generate high-fidelity desktop/mobile targets for priority flows and inspect at readable scale before coding; image concepts are review targets, not executable UI or evidence of working functionality.

### Semantic token architecture (proposal; no CSS changes)
1. Primitive: existing canonical colors, type stacks, spacing, radius, shadows. Maintain current color values in tokens.css; no second literal palette.
2. Product semantics: backgrounds/surfaces/text/secondary text, primary action, focus, boundary, disabled, selection, critical/success/warning/info; calendar states not solely color-coded.
3. Tenant public tokens: validated appearance contract #223; exactly four curated presets and bounded overrides; public shell scope only, no arbitrary CSS or external asset dependencies. Product navigation unaffected.
4. Channel shell tokens: safe area, viewport, theme context (where trusted), input modality. Never override business contract or auth state.
5. Component-local tokens: only where needed; reusable values promoted to canonical semantics after review.

Typography: system sans for dense UI; editorial face only in intentional customer brand moments. Keep numbers/time readable, avoid unnecessary uppercase and decorative labels. Proposed spacing rhythm 4px-based with optical exceptions; use a compact work surface without making controls too small. Keep current documented 12–16px surface and 8–9px control radius until visual review. Avoid nested cards; prefer lists/tables/calendar grid, dividers, and single meaningful panels. One clear primary action per task, with destructive actions clearly separated. Motion only for feedback and spatial continuity; reduced-motion respected.

Layout: desktop rail + workspace; mobile task-first single column, bottom nav for frequent destinations, secondary sheet; exact items subject to role/flow review. Calendar has intentional own-axis scroll, stable date/headers, accessible list fallback as needed; no accidental page overflow. Client flow maintains selection/back, no faux step counters; slot and actual server price/confirmation explicit. A month-view concept is proposed, not an accepted feature scope.

### Component contracts
Use existing version-controlled shadcn-svelte/Bits UI + Lucide; preserve Svelte 5/Vite and typed props/callbacks. Do not install React components or translate upstream React APIs literally. Compose primitives: button, input/label, select, checkbox, radio, tabs, dialog/sheet, alert, spinner/skeleton, status text, menu. Domain patterns: service/master selector, date/slot picker, appointment summary, booking detail, owner list/editor, calendar grid/list, organization switcher, upload preview. Each catalog entry documents variants, keyboard behavior, loading/disabled/error, 320px behavior, component owner and token mapping. Existing primitives before a custom implementation; avoid redundant libraries. Plan the catalog incrementally alongside screens.

### Accessibility and performance gates (proposed)
WCAG 2.2 AA target; verify rather than certify. Text contrast >=4.5:1 normal, >=3:1 large; meaningful UI boundaries/focus >=3:1 where applicable. Aim for >=44px touch hit area on primary touch controls; verify WCAG target size and exceptions. Keyboard paths, visible focus and restore, semantic labels, status announcement, accessible dialogs, reduced motion, text zoom/reflow, no color-only status. Long Russian text, missing image, no data, long names and failed connections are design test fixtures.
Measure LCP/INP/CLS, bundle and calendar interaction on repeatable real-device scenario before adopting budgets; do not invent measurements. No third-party font requirement or expensive decorative dependencies.

## 4. Design work order and review
| Track | Deliverable | Existing issue | Dependency |
|---|---|---|---|
| D0 | source registry + real-runtime screenshot audit, evidence ledger | #338/#13 | no new product code |
| D1 | concept, semantic tokens/component conventions and scoped public theme | #338/#27/#223 | D0 visual evidence + owner visual review |
| D2 | role-aware information architecture, nav/deep-link/back & shell patterns | #13/#26/#24/#309 | D1; actual capabilities |
| D3 | customer booking, conflict/recovery, history/manage; desktop/mobile concepts first | #23/#24/#25/#222 | D1/D2; server contracts |
| D4 | business daily calendar/booking detail first, setup and catalog, staff/schedule/location/appearance | #23/#26/#223/#285/#309 | D1/D2; #203 coordination |
| D5 | CRM, roles, analytics/discounts, subscriptions, import/export, Telegram admin | #25/#26/#28/#252/#253 | F2 dependencies, no speculative implementation |
| D6 | reusable UI catalog and state examples maintained from D1 onward | #27/#338 | each flow contributes patterns |
| D7 | real device visual QA and owner review, continuous per screen | #13/#23/#338 | actual working UI |

D3 and D4 can design independently after shared decisions, but their booking/date/pricing states share one contract. For every implementation PR, reserve a bounded issue/comment, compare open PRs, use an isolated branch and avoid changing common tokens and global shell in parallel without coordination. No merge authorization from this document.

## 5. Per-screen acceptance
1. READY: stable ID, route/entry/exit, actor + capability, phase, REQ/DEC/Issue linkage; expected real data, primary action, information priority, fallback/recovery, no invented API.
2. UX: user flow and meaningful happy/loading/empty/invalid/error/conflict/forbidden/expired/unknown-result states (only applicable), mobile navigation, focus behavior, disabled action explanation.
3. VISUAL: legible desktop/mobile and relevant channel concepts; exact visible copy, composition and component mapping. Owner approves material changes; baseline reused for bounded corrections.
4. CODE: scoped CSS and semantic tokens, shared primitives, typed view props; server determines price, authorizations, availability and commits. Preserve #311 demo/real parity and #285 configurable policies.
5. QA: same commit SHA real-runtime evidence then fixture isolation checks; Chromium 1280x800, 375x812, 320x568 and proposed tablet 768x1024; review screenshots individually and compare to selected target. Exercise interaction, keyboard, console and errors, long copy and no overflow. Physical Android/iOS and Telegram WebView separately. Run repo-prescribed checks and actual backend E2E. Record evidence URL, SHA, runtime, device, state and deviations. Not run != pass.
6. ACCEPTED: owner approval of visual spec and fidelity evidence; never mistake CI success for visual signoff or real pilot approval.

## 6. Immediate next slice
- D0 visual audit on `pnpm demo:local` or controlled real staging with synthetic data only; record SHA/startup route, screenshots and interactions for public booking, daily calendar, setup/owner auth. Use fixture separately only to enumerate states, not establish real feature readiness. Browser-first; if unavailable record blocker and use repository Chromium/Playwright in capable environment.
- D1 review: refine the existing direction, not wholesale restyle. Prepare two priority screen concept pairs (customer booking and business calendar; desktop and mobile, key states separately). Compare against existing screenshots, get owner approval, derive semantic tokens and component rules before implementation.
- Resolve evidence gaps, keep docs synchronized with real runtime; inspect active auth PRs before designing sign-in changes. No new feature code in this proposal.
