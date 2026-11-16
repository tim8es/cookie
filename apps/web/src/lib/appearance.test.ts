import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultSalonAppearance,
  isSalonTheme,
  normalizeSalonAppearance,
  salonThemes,
} from "./appearance";

test("four curated salon appearance presets have distinct IDs and stable contrasts", () => {
  assert.equal(salonThemes.length, 4);
  assert.equal(new Set(salonThemes.map((theme) => theme.id)).size, 4);
  for (const theme of salonThemes) {
    assert.ok(isSalonTheme(theme.id));
    assert.match(theme.hero, /^#[0-9a-f]{6}$/i);
    assert.match(theme.ticket, /^#[0-9a-f]{6}$/i);
    assert.match(theme.accent, /^#[0-9a-f]{6}$/i);
  }
  assert.equal(isSalonTheme("cookie"), false);
});

test("legacy and malformed persisted appearance fails safe to explicit default", () => {
  assert.deepEqual(normalizeSalonAppearance(undefined), defaultSalonAppearance);
  assert.deepEqual(normalizeSalonAppearance({ theme: "not-a-theme", introduction: "" }), defaultSalonAppearance);
  assert.deepEqual(normalizeSalonAppearance({ theme: "forest", introduction: "  Здравствуйте  " }), {
    theme: "forest",
    introduction: "Здравствуйте",
  });
  assert.deepEqual(normalizeSalonAppearance({ theme: "clay", introduction: "a".repeat(121) }), {
    theme: "clay",
    introduction: defaultSalonAppearance.introduction,
  });
});
