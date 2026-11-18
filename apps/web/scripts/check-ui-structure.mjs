// Protect a small, predictable UI file structure for future agents.
// Does not test visual quality: browser smoke plus human screenshots still do.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../src");
const read = (path) => readFileSync(join(root, path), "utf8");
const paths = [
  "styles/tokens.css",
  "styles/foundation.css",
  "styles/booking.css",
  "styles/onboarding.css",
  "styles/responsive.css",
  "styles/first-run.css",
  "styles/ledger.css",
  "styles/owner-forms.css",
  "styles/appearance.css",
  "styles/calendar.css",
  "styles/feedback.css",
];

for (const path of paths) {
  assert.ok(existsSync(join(root, path)), `Missing UI module: ${path}`);
}

const index = read("visual-system.css");
const actual = [...index.matchAll(/@import "\.\/([^"]+)";/g)].map((match) => match[1]);
assert.deepEqual(actual, paths, "Visual CSS import order must stay explicit and token-first");
assert.ok(index.length < 1200, "Visual entrypoint must stay import-only, not become another giant stylesheet");

const compatibilityEntrypoint = read("styles.css");
const compatPaths = [
  "styles/compat/base.css",
  "styles/compat/workspace.css",
  "styles/compat/public.css",
];
const compatImports = [...compatibilityEntrypoint.matchAll(/@import "\.\/([^"]+)";/g)]
  .map((match) => match[1]);
assert.deepEqual(compatImports, compatPaths, "Preserve the historical CSS cascade in compatibility imports");
assert.ok(compatibilityEntrypoint.length < 800, "Legacy entrypoint must not contain new CSS selectors");
assert.ok(!/[{}]/.test(compatibilityEntrypoint), "Legacy entrypoint must be imports and comments only");
for (const path of compatPaths) {
  assert.ok(existsSync(join(root, path)), `Missing compatibility CSS: ${path}`);
}
const compatibility = compatPaths.map(read).join("");
assert.ok(
  compatibility.length <= 35591,
  "Compatibility CSS must shrink from its 2026-11-16 baseline. Add new styles to src/styles/<screen>.css",
);
assert.ok(!compatibility.includes("--green: #"), "Obsolete green palettes must not be reintroduced");
assert.ok(!compatibility.includes(".welcome-metrics"), "Retired onboarding rules must not return");
assert.ok(!compatibility.includes(".summary-visual"), "Retired booking-summary rules must not return");

const tokens = read("styles/tokens.css");
for (const name of [
  "--cookie-paper", "--cookie-surface", "--cookie-ink",
  "--cookie-brand", "--cookie-hero", "--cookie-owner-rail",
  "--cookie-ticket", "--cookie-onboarding", "--cookie-lime",
  "--cookie-border", "--cookie-radius-surface",
  "--cookie-radius-control", "--cookie-font-ui", "--cookie-font-editorial",
]) {
  assert.ok(tokens.includes(name + ":"), `Missing design token ${name}`);
}

for (const path of ["OnboardingScreen.svelte", "OwnerOverview.svelte", "BookingForm.svelte", "BookingSummary.svelte", "ServiceForm.svelte", "StaffForm.svelte", "ScheduleForm.svelte", "LocationForm.svelte", "OwnerFormHeader.svelte", "CalendarView.svelte", "BookingDetail.svelte", "OwnerServicesPage.svelte", "OwnerStaffPage.svelte", "OwnerSchedulePage.svelte", "OwnerLocationsPage.svelte", "BookingConfirmation.svelte", "DemoState.svelte", "PublicBookingHero.svelte", "DemoFooter.svelte", "DemoNotices.svelte", "BookingSetupHint.svelte"]) {
  assert.ok(existsSync(join(root, "lib/ui", path)), `Missing presentational screen: ${path}`);
}
const runtime = read("App.svelte");
assert.match(runtime, /<RealOwnerWorkspace\b/, "Runtime must compose the real owner workspace");
assert.match(runtime, /<StagingCustomerGate\b/, "Runtime must compose the real customer workspace");
assert.doesNotMatch(runtime, /createCookieUiApi|LegacyFixture|MockCookieApi|<DemoFooter\b/, "Runtime must not orchestrate the old mock");
const app = read("LegacyFixture.svelte");
assert.match(app, /<OnboardingScreen\b/, "App must compose the onboarding screen");
assert.match(app, /<OwnerOverview\b/, "App must compose the owner overview");
assert.match(app, /<BookingForm\b/, "App must compose the booking form");
assert.match(app, /<CalendarView\b/, "App must compose the calendar");
for (const name of ["OwnerServicesPage", "OwnerStaffPage", "OwnerSchedulePage", "OwnerLocationsPage", "BookingConfirmation", "DemoState", "PublicBookingHero", "DemoFooter", "DemoNotices", "BookingSetupHint"]) {
  assert.match(app, new RegExp("<" + name + "\\b"), "App must compose " + name + " instead of inline screen markup");
}
assert.ok(!app.includes('<div class="workspace-grid">'), "Owner screen markup belongs in separate Page components");
assert.ok(!app.includes('<section class="booking-head booking-hero"'), "Public booking hero belongs in a presentation component");
assert.ok(!app.includes('<footer class="footer"'), "Footer belongs in a presentation component");
assert.ok(!app.includes('<div class="alert alert-error"'), "Alert markup belongs in a presentation component");
assert.ok(existsSync(join(root, "../AGENTS.md")), "Web agent instructions must be present");


console.log("PASS Cookie UI file structure: semantic tokens, ordered styles and presentational screens");
