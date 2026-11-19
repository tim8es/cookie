import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(
  new URL("./components/rhythm/rhythm.css", import.meta.url),
  "utf8",
);

function colors(selector: string): Record<string, string> {
  const start = css.indexOf(selector + " {");
  assert.ok(start >= 0, selector);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    Array.from(block.matchAll(/--rhythm-([\w-]+):\s*(#[\da-f]{6});/gi), (m) => [
      m[1]!,
      m[2]!,
    ]),
  );
}

function luminance(hex: string): number {
  const convert = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * convert(Number.parseInt(hex.slice(1, 3), 16)) +
    0.7152 * convert(Number.parseInt(hex.slice(3, 5), 16)) +
    0.0722 * convert(Number.parseInt(hex.slice(5, 7), 16))
  );
}

function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const workspace = colors(".rhythm-scope");
for (const theme of ["workspace", "studio", "linen", "graphite", "sage"]) {
  const palette = {
    ...workspace,
    ...(theme === "workspace"
      ? {}
      : colors('.rhythm-scope[data-rhythm-theme="' + theme + '"]')),
  };
  test("Rhythm " + theme + ": semantic contrast", () => {
    for (const [foreground, background, min] of [
      ["ink", "canvas", 4.5],
      ["surface-ink", "surface", 4.5],
      ["muted", "canvas", 4.5],
      ["on-brand", "brand", 4.5],
      ["on-selected", "selected", 4.5],
      ["danger", "canvas", 4.5],
      ["line", "canvas", 3],
      ["focus", "canvas", 3],
      ["selected-line", "canvas", 3],
    ] as const) {
      const a = palette[foreground];
      const b = palette[background];
      assert.ok(a && b, foreground + "/" + background);
      assert.ok(
        contrast(a, b) >= min,
        theme + " " + foreground + "/" + background,
      );
    }
  });
}

test("unselected catalog choices follow the scoped canvas", () => {
  const selector = ".rhythm-scope .rhythm-choice {";
  const index = css.indexOf(selector);
  assert.ok(index >= 0);
  assert.match(
    css.slice(index, css.indexOf("}", index)),
    /background: var\(--rhythm-canvas\);/,
  );
});
