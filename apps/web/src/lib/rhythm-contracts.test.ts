import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = ["workspace.css", "rhythm.css"]
  .map((file) =>
    readFileSync(
      new URL("./components/rhythm/" + file, import.meta.url),
      "utf8",
    ),
  )
  .join("\n");

function colors(selector: string): Record<string, string> {
  const start = css.indexOf(selector + " {");
  assert.ok(start >= 0, selector);
  const block = css.slice(start, css.indexOf("}", start));
  const matches = block.matchAll(/--rhythm-([\w-]+):\s*(#[\da-f]{6});/gi);
  const result: Record<string, string> = {};
  for (const match of matches) {
    const [, name, value] = match;
    if (name && value) result[name] = value;
  }
  return result;
}

function luminance(hex: string): number {
  const convert = (channel: number) => {
    const value = channel / 255;
    if (value <= 0.04045) return value / 12.92;
    return ((value + 0.055) / 1.055) ** 2.4;
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

function colorsForTheme(theme: string): Record<string, string> {
  if (theme === "workspace") return {};
  const selector = '.rhythm-scope[data-rhythm-theme="' + theme + '"]';
  return colors(selector);
}

const workspace = colors(".rhythm-scope");
for (const theme of ["workspace", "studio", "linen", "graphite", "sage"]) {
  const palette = {
    ...workspace,
    ...colorsForTheme(theme),
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
      const explanation = theme + " " + foreground + "/" + background;
      assert.ok(contrast(a, b) >= min, explanation);
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
