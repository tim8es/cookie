// Fail-closed CI evidence check: verify all synthetic browser captures were generated.
// No additional dependencies, network calls, credentials, customer data or deployment.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const directory = resolve("apps/web/artifacts/visual-smoke");
const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
const viewports = ["1280x800", "375x812", "320x568"];
// Order is the immutable browser-smoke manifest contract, not screenshot order.
const captures = [
  "onboarding", "booking", "confirmation", "calendar-week", "detail",
  "calendar-day", "workspace", "services", "staff", "schedule",
  "locations", "appearance-preview", "themed-booking", "themed-confirmation",
  "unavailable-booking", "sunday-unavailable", "next-day-recovery",
  "slot-lookup-error", "retry-restored", "error-preview", "forbidden-preview",
];

// Screenshot stage numbers are historical and stay stable when new stages
// are appended. Do not infer filenames from manifest array positions.
const screenshotStages = [
  "01-onboarding", "02-booking", "03-confirmation", "04-calendar-week",
  "05-detail", "06-calendar-day", "07-workspace", "08-services", "09-staff",
  "10-schedule", "11-locations", "12-error-preview", "13-forbidden-preview",
  "14-appearance-preview", "15-themed-booking", "16-unavailable-booking",
  "17-themed-confirmation", "18-sunday-unavailable", "19-next-day-recovery",
  "20-slot-lookup-error", "21-retry-restored",
];
assert.equal(
  new Set(screenshotStages).size,
  screenshotStages.length,
  "Screenshot stages must be unique",
);
assert.deepEqual(
  new Set(screenshotStages.map((stage) => stage.slice(3))),
  new Set(captures),
  "Manifest and screenshot stages must cover the same scenes",
);

assert.equal(manifest.data, "synthetic sessionStorage only", "Only synthetic sessions are permitted");
assert.equal(manifest.backend, "not connected", "Browser evidence must not include a real backend");
assert.equal(manifest.chromium, "headless");
assert.equal(manifest.externalRequests, 0, "Visual evidence may not contact external services");
assert.deepEqual(manifest.viewports, viewports, "All declared screen sizes are mandatory");
assert.deepEqual(manifest.captures, captures, "All browser scenes are mandatory");

const expected = new Set(["manifest.json"]);
for (const viewport of viewports) {
  const [width, height] = viewport.split("x").map(Number);
  for (const stage of screenshotStages) {
    const filename = viewport + "-" + stage + ".png";
    expected.add(filename);
    const path = join(directory, filename);
    const png = readFileSync(path);
    assert.ok(statSync(path).isFile(), filename + ": expected a regular screenshot");
    assert.ok(png.length > 1500, filename + ": image unexpectedly small");
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", filename + ": invalid PNG header");
    assert.equal(png.readUInt32BE(16), width, filename + ": wrong viewport width");
    // The browser captures full document height except the detail screen,
    // which intentionally clips to the viewport. Never accept a truncated
    // screenshot shorter than its declared emulated viewport.
    const imageHeight = png.readUInt32BE(20);
    if (stage === "05-detail") {
      assert.equal(imageHeight, height, filename + ": wrong detail viewport height");
    } else {
      assert.ok(imageHeight >= height, filename + ": screenshot shorter than viewport");
    }
  }
}
assert.deepEqual(new Set(readdirSync(directory)), expected, "Unexpected/missing synthetic evidence");
console.log(
  "PASS: manifest and all " + (viewports.length * screenshotStages.length) +
    " synthetic viewport PNG captures validated",
);
