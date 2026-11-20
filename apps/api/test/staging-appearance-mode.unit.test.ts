import assert from "node:assert/strict";
import test from "node:test";

import { parseControlledAppearanceMode } from "../src/staging-appearance-mode.js";

test("Appearance publication stays off by default even with general staging enabled", () => {
  assert.equal(parseControlledAppearanceMode(undefined, false), false);
  assert.equal(parseControlledAppearanceMode(undefined, true), false);
  assert.equal(parseControlledAppearanceMode("disabled", true), false);
});

test("Appearance publication requires both explicit staging opt-ins", () => {
  assert.equal(parseControlledAppearanceMode("enabled", true), true);
  assert.throws(
    () => parseControlledAppearanceMode("enabled", false),
    /Appearance staging requires staging publication mode/,
  );
});

test("malformed Appearance mode fails closed rather than becoming enabled", () => {
  for (const raw of ["", "Enabled", "true", "1", "enabled "]) {
    assert.throws(
      () => parseControlledAppearanceMode(raw, true),
      /Invalid staging publication mode/,
    );
  }
});
