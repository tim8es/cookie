import assert from "node:assert/strict";
import { test } from "node:test";
import {
  brandContrast,
  brandPresets,
  compileBrandTokens,
  createBrandConfig,
  validateBrandConfig,
} from "./branding-config";

test("exactly four branded presets include light and dark modes", () => {
  assert.deepEqual(
    brandPresets.map((preset) => preset.id),
    ["atelier", "forest", "ocean", "clay"],
  );
  assert.equal(new Set(brandPresets.map((preset) => preset.id)).size, 4);
  assert.deepEqual(
    new Set(brandPresets.map((preset) => preset.mode)),
    new Set(["light", "dark"]),
  );
  for (const preset of brandPresets) {
    const settings = createBrandConfig(preset.id);
    assert.equal(validateBrandConfig(settings).presetId, preset.id);
    assert.ok(
      brandContrast(settings.primaryColor, settings.accentColor) >= 4.5,
    );
    const tokens = compileBrandTokens(settings);
    assert.ok(
      brandContrast(tokens["--salon-hero"]!, tokens["--salon-hero-ink"]!) >=
        4.5,
    );
    assert.ok(
      brandContrast(
        tokens["--salon-page-background"]!,
        tokens["--salon-page-ink"]!,
      ) >= 4.5,
    );
    assert.ok(
      brandContrast(tokens["--salon-accent"]!, tokens["--salon-accent-ink"]!) >=
        4.5,
    );
    assert.ok(
      !Object.values(tokens).some((value) =>
        /url\s*\(|data:|javascript:/i.test(value),
      ),
    );
  }
});

test("owner's bounded choices compile to safe predictable token values", () => {
  const settings = {
    ...createBrandConfig("atelier"),
    backgroundColor: "#FAFAFA",
    primaryColor: "#13233F",
    accentColor: "#E9F7D5",
    buttonRadius: "pill",
    typography: "modern",
    accentStyle: "line",
    logoAssetId: "brandAsset_E9ShtX7_u7QHJ",
    backgroundAssetId: "brandAsset_Bg4_c6KftH",
  };
  const safe = validateBrandConfig(settings);
  assert.equal(safe.primaryColor, "#13233f");
  const tokens = compileBrandTokens(safe);
  assert.equal(tokens["--salon-button-radius"], "999px");
  assert.equal(tokens["--salon-accent-width"], "2px");
  assert.equal(tokens["--salon-color-scheme"], "light");
  assert.match(tokens["--salon-font-heading"]!, /system-ui/);
  assert.equal(Object.keys(tokens).length, 11);
  assert.ok(!Object.values(tokens).includes(safe.logoAssetId ?? ""));
});

test("rejects invalid colors, unsupported styles, untrusted assets and unknown fields", () => {
  const base = createBrandConfig("atelier");
  const bad = [
    { ...base, version: 2 },
    { ...base, mode: "auto" },
    { ...base, presetId: "my-custom-css" },
    { ...base, buttonRadius: "999px; color:red" },
    { ...base, typography: "url(https://evil)" },
    { ...base, accentStyle: "javascript:alert(1)" },
    { ...base, primaryColor: "var(--untrusted)" },
    { ...base, accentColor: "#aabbcc;" },
    { ...base, backgroundColor: "url(javascript:alert(1))" },
    { ...base, primaryColor: "#ffffff", accentColor: "#eeeeee" },
    { ...base, logoAssetId: "https://evil.invalid/logo.png" },
    { ...base, backgroundAssetId: "data:image/svg+xml;base64,PHN2Zz4=" },
    { ...base, extraCss: "body{display:none}" },
    { ...base, logoAssetId: undefined },
  ];
  for (const input of bad) {
    assert.throws(() => validateBrandConfig(input), Error);
  }
  assert.throws(() => validateBrandConfig(null));
  assert.throws(() => validateBrandConfig({}));
  assert.throws(() => compileBrandTokens("url(https://evil.invalid)"));
});

test("config is versioned and cannot silently accept old or future shapes", () => {
  const base = createBrandConfig();
  assert.equal(base.version, 1);
  assert.throws(() => validateBrandConfig({ ...base, version: 0 }));
  assert.throws(() => validateBrandConfig({ ...base, version: 3 }));
  assert.throws(() =>
    validateBrandConfig({ ...base, logoAssetId: null, colorCss: ".body{}" }),
  );
  assert.deepEqual(validateBrandConfig(base), base);
});
