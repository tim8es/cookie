import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultSalonAppearance,
  isSalonTheme,
  normalizeSalonAppearance,
  salonThemes,
} from "./appearance";

function contrastRatio(left: string, right: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map(
      (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
    );
    const linear = channels.map((channel) =>
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return (
      linear[0]! * 0.2126 +
      linear[1]! * 0.7152 +
      linear[2]! * 0.0722
    );
  };
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test(
  "four curated salon appearance presets have distinct IDs and stable contrasts",
  () => {
    assert.equal(salonThemes.length, 4);
    assert.equal(new Set(salonThemes.map((theme) => theme.id)).size, 4);
    for (const theme of salonThemes) {
      assert.ok(isSalonTheme(theme.id));
      assert.match(theme.hero, /^#[0-9a-f]{6}$/i);
      assert.match(theme.ticket, /^#[0-9a-f]{6}$/i);
      assert.match(theme.accent, /^#[0-9a-f]{6}$/i);
      assert.ok(
        contrastRatio(theme.hero, "#ffffff") >= 4.5,
        theme.id + " white body copy",
      );
      assert.ok(
        contrastRatio(theme.hero, theme.accent) >= 4.5,
        theme.id + " editorial accent",
      );
    }
    assert.equal(isSalonTheme("cookie"), false);
  },
);

test(
  "legacy and malformed persisted appearance fails safe to explicit default",
  () => {
    assert.deepEqual(
      normalizeSalonAppearance(undefined),
      defaultSalonAppearance,
    );
    assert.deepEqual(
      normalizeSalonAppearance({ theme: "not-a-theme", introduction: "" }),
      defaultSalonAppearance,
    );
    assert.deepEqual(
      normalizeSalonAppearance({
        theme: "forest",
        introduction: "  Здравствуйте  ",
      }),
      {
        theme: "forest",
        introduction: "Здравствуйте",
      },
    );
    assert.deepEqual(
      normalizeSalonAppearance({
        theme: "clay",
        introduction: "a".repeat(121),
      }),
      {
        theme: "clay",
        introduction: defaultSalonAppearance.introduction,
      },
    );
  },
);
