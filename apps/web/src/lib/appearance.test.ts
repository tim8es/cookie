import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultSalonAppearance,
  isSalonTheme,
  normalizeSalonAppearance,
  salonThemes,
} from "./appearance";

function linear(value: number): number {
  if (value <= 0.04045) return value / 12.92;
  return ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const red = linear(parseInt(hex.slice(1, 3), 16) / 255);
  const green = linear(parseInt(hex.slice(3, 5), 16) / 255);
  const blue = linear(parseInt(hex.slice(5, 7), 16) / 255);
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(a: string, b: string): number {
  const left = luminance(a);
  const right = luminance(b);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

test("curated salon palettes meet text contrast", () => {
  assert.equal(salonThemes.length, 4);
  const ids = salonThemes.map((theme) => theme.id);
  assert.equal(new Set(ids).size, 4);
  for (const theme of salonThemes) {
    assert.ok(isSalonTheme(theme.id));
    assert.ok(contrast(theme.hero, "#ffffff") >= 4.5);
    assert.ok(contrast(theme.hero, theme.accent) >= 4.5);
  }
  assert.equal(isSalonTheme("cookie"), false);
});

test("invalid appearance restores safe defaults", () => {
  assert.deepEqual(normalizeSalonAppearance(null), defaultSalonAppearance);
  const broken = { theme: "unknown", introduction: "" };
  assert.deepEqual(normalizeSalonAppearance(broken), defaultSalonAppearance);
  const good = { theme: "forest", introduction: "  Гости  " };
  const result = normalizeSalonAppearance(good);
  assert.equal(result.theme, "forest");
  assert.equal(result.introduction, "Гости");
  const tooLong = { theme: "clay", introduction: "x".repeat(121) };
  const fallback = normalizeSalonAppearance(tooLong);
  assert.equal(fallback.introduction, defaultSalonAppearance.introduction);
});
