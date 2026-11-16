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

for (const path of ["OnboardingScreen.svelte", "OwnerOverview.svelte", "BookingForm.svelte", "BookingSummary.svelte", "ServiceForm.svelte", "StaffForm.svelte", "ScheduleForm.svelte", "LocationForm.svelte", "OwnerFormHeader.svelte", "CalendarView.svelte", "BookingDetail.svelte", "OwnerServicesPage.svelte", "OwnerStaffPage.svelte", "OwnerSchedulePage.svelte", "OwnerLocationsPage.svelte", "BookingConfirmation.svelte", "DemoState.svelte"]) {
  assert.ok(existsSync(join(root, "lib/ui", path)), `Missing presentational screen: ${path}`);
}
const app = read("App.svelte");
assert.match(app, /<OnboardingScreen\b/, "App must compose the onboarding screen");
assert.match(app, /<OwnerOverview\b/, "App must compose the owner overview");
assert.match(app, /<BookingForm\b/, "App must compose the booking form");
assert.match(app, /<CalendarView\b/, "App must compose the calendar");

console.log("PASS Cookie UI file structure: semantic tokens, ordered styles and presentational screens");
