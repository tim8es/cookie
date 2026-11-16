// Fail-closed CI evidence check: verify all synthetic browser captures were generated.
// No additional dependencies, network calls, credentials, customer data or deployment.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const directory = resolve("apps/web/artifacts/visual-smoke");
const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
const viewports = ["1280x800", "375x812", "320x568"];
const captures = [
  "onboarding", "booking", "confirmation", "calendar-week", "detail",
  "calendar-day", "workspace", "services", "staff", "schedule",
  "locations", "error-preview", "forbidden-preview",
];

assert.equal(manifest.data, "synthetic sessionStorage only", "Only synthetic sessions are permitted");
assert.equal(manifest.backend, "not connected", "Browser evidence must not include a real backend");
assert.equal(manifest.chromium, "headless");
assert.equal(manifest.externalRequests, 0, "Visual evidence may not contact external services");
assert.deepEqual(manifest.viewports, viewports, "All declared screen sizes are mandatory");
assert.deepEqual(manifest.captures, captures, "All browser scenes are mandatory");

const expected = new Set(["manifest.json"]);
for (const viewport of viewports) {
  const [width, height] = viewport.split("x").map(Number);
  for (let i = 0; i < captures.length; i++) {
    const stage = String(i + 1).padStart(2, "0") + "-" + captures[i];
    const filename = viewport + "-" + stage + ".png";
    expected.add(filename);
    const path = join(directory, filename);
    const png = readFileSync(path);
    assert.ok(statSync(path).isFile(), filename + ": expected a regular screenshot");
    assert.ok(png.length > 1500, filename + ": image unexpectedly small");
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", filename + ": invalid PNG header");
    assert.equal(png.readUInt32BE(16), width, filename + ": wrong viewport width");
    assert.equal(png.readUInt32BE(20), height, filename + ": wrong viewport height");
  }
}
assert.deepEqual(new Set(readdirSync(directory)), expected, "Unexpected/missing synthetic evidence");
console.log("PASS: manifest and all 39 synthetic viewport PNG captures validated");
