/**
 * Stable, transport-neutral branding configuration for a boxed Cookie installation.
 *
 * This module only validates the data contract and compiles safe CSS tokens.
 * The Appearance business module owns authorization, persistence, publication,
 * asset validation and tenant-scoped delivery. A browser cannot publish changes.
 */

export type BrandPresetId = "atelier" | "forest" | "ocean" | "clay";
export type BrandColorMode = "light" | "dark";
export type BrandButtonRadius = "compact" | "soft" | "round" | "pill";
export type BrandTypography = "editorial" | "modern" | "humanist" | "classic";
export type BrandAccentStyle = "minimal" | "line" | "filled" | "highlight";

export interface BrandConfigV1 {
  version: 1;
  presetId: BrandPresetId;
  mode: BrandColorMode;
  backgroundColor: string;
  primaryColor: string;
  accentColor: string;
  buttonRadius: BrandButtonRadius;
  typography: BrandTypography;
  accentStyle: BrandAccentStyle;
  logoAssetId: string | null;
  backgroundAssetId: string | null;
}

export interface BrandPreset {
  id: BrandPresetId;
  label: string;
  description: string;
  mode: BrandColorMode;
  backgroundColor: string;
  primaryColor: string;
  accentColor: string;
  buttonRadius: BrandButtonRadius;
  typography: BrandTypography;
  accentStyle: BrandAccentStyle;
}

/** Exactly four curated designs; mode, typography and shapes are part of each. */
export const brandPresets: readonly BrandPreset[] = [
  {
    id: "atelier",
    label: "Ателье",
    description: "Светлый, редакционный, с мягкими углами",
    mode: "light",
    backgroundColor: "#faf7fa",
    primaryColor: "#3d2a48",
    accentColor: "#e0f2a5",
    buttonRadius: "soft",
    typography: "editorial",
    accentStyle: "minimal",
  },
  {
    id: "forest",
    label: "Ботаника",
    description: "Тёмный, природный, с округлыми кнопками",
    mode: "dark",
    backgroundColor: "#192c24",
    primaryColor: "#24483b",
    accentColor: "#e4eeb9",
    buttonRadius: "pill",
    typography: "humanist",
    accentStyle: "highlight",
  },
  {
    id: "ocean",
    label: "Горизонт",
    description: "Светлый, графичный, с чёткими акцентами",
    mode: "light",
    backgroundColor: "#eef5fa",
    primaryColor: "#23455e",
    accentColor: "#cce8f2",
    buttonRadius: "compact",
    typography: "modern",
    accentStyle: "line",
  },
  {
    id: "clay",
    label: "Терракота",
    description: "Тёмный, тёплый, с плавными формами",
    mode: "dark",
    backgroundColor: "#2e211d",
    primaryColor: "#704234",
    accentColor: "#f1dfa9",
    buttonRadius: "round",
    typography: "classic",
    accentStyle: "filled",
  },
] as const;

const radiusTokens: Record<BrandButtonRadius, string> = {
  compact: "6px",
  soft: "11px",
  round: "19px",
  pill: "999px",
};

const fontTokens: Record<BrandTypography, string> = {
  editorial: 'Georgia, "Times New Roman", serif',
  modern: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  humanist: 'Verdana, "Trebuchet MS", sans-serif',
  classic: '"Palatino Linotype", Palatino, Georgia, serif',
};

const accentTokens: Record<BrandAccentStyle, string> = {
  minimal: "0px",
  line: "2px",
  filled: "4px",
  highlight: "6px",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function requireHex(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^#[a-fA-F0-9]{6}$/.test(value)) {
    throw new Error("Invalid " + field + ": only #RRGGBB colors are permitted");
  }
  return value.toLowerCase();
}

/** Accept only opaque, tenant-owned server asset identifiers, never URL/data/SVG markup. */
function requireAssetId(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{16,96}$/.test(value)) {
    throw new Error("Invalid " + field + ": expected a validated server asset ID");
  }
  return value;
}

function linear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const parts = [1, 3, 5].map((start) => linear(parseInt(hex.slice(start, start + 2), 16) / 255));
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
}

/** WCAG 2.x relative-luminance contrast for two validated opaque hex colors. */
export function brandContrast(a: string, b: string): number {
  const left = luminance(requireHex(a, "foreground"));
  const right = luminance(requireHex(b, "background"));
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function readableInk(background: string): string {
  const nearBlack = "#151820";
  const nearWhite = "#ffffff";
  return brandContrast(nearBlack, background) >= brandContrast(nearWhite, background)
    ? nearBlack
    : nearWhite;
}

export function createBrandConfig(presetId: BrandPresetId = "atelier"): BrandConfigV1 {
  const preset = brandPresets.find((item) => item.id === presetId);
  if (!preset) throw new Error("Unknown Cookie branding preset");
  return {
    version: 1,
    presetId: preset.id,
    mode: preset.mode,
    backgroundColor: preset.backgroundColor,
    primaryColor: preset.primaryColor,
    accentColor: preset.accentColor,
    buttonRadius: preset.buttonRadius,
    typography: preset.typography,
    accentStyle: preset.accentStyle,
    logoAssetId: null,
    backgroundAssetId: null,
  };
}

/**
 * Fail closed at the publish boundary. Do not silently replace bad tenant
 * values with a different design or allow arbitrary CSS declarations.
 */
export function validateBrandConfig(value: unknown): BrandConfigV1 {
  if (!isRecord(value)) throw new Error("Invalid Cookie branding configuration");
  const fields = [
    "version", "presetId", "mode", "backgroundColor", "primaryColor",
    "accentColor", "buttonRadius", "typography", "accentStyle",
    "logoAssetId", "backgroundAssetId",
  ];
  if (Object.keys(value).some((key) => !fields.includes(key)) ||
      fields.some((field) => !Object.hasOwn(value, field))) {
    throw new Error("Unknown or missing Cookie branding configuration field");
  }
  if (value.version !== 1) throw new Error("Unsupported branding config version");
  const presetIds = brandPresets.map((preset) => preset.id);
  if (!isOneOf(value.presetId, presetIds) ||
      !isOneOf(value.mode, ["light", "dark"] as const) ||
      !isOneOf(value.buttonRadius, ["compact", "soft", "round", "pill"] as const) ||
      !isOneOf(value.typography, ["editorial", "modern", "humanist", "classic"] as const) ||
      !isOneOf(value.accentStyle, ["minimal", "line", "filled", "highlight"] as const)) {
    throw new Error("Unsupported Cookie branding style");
  }
  const primaryColor = requireHex(value.primaryColor, "primaryColor");
  const accentColor = requireHex(value.accentColor, "accentColor");
  const backgroundColor = requireHex(value.backgroundColor, "backgroundColor");
  if (brandContrast(primaryColor, accentColor) < 4.5) {
    throw new Error("Accent and primary colors need at least 4.5:1 text contrast");
  }
  return {
    version: 1,
    presetId: value.presetId,
    mode: value.mode,
    primaryColor,
    accentColor,
    backgroundColor,
    buttonRadius: value.buttonRadius,
    typography: value.typography,
    accentStyle: value.accentStyle,
    logoAssetId: requireAssetId(value.logoAssetId, "logoAssetId"),
    backgroundAssetId: requireAssetId(value.backgroundAssetId, "backgroundAssetId"),
  };
}

/** CSS properties are a finite allowlist, not user-supplied stylesheets or URLs. */
export function compileBrandTokens(raw: unknown): Readonly<Record<string, string>> {
  const config = validateBrandConfig(raw);
  return {
    "--salon-primary": config.primaryColor,
    "--salon-hero": config.primaryColor,
    "--salon-hero-ink": readableInk(config.primaryColor),
    "--salon-accent": config.accentColor,
    "--salon-accent-ink": readableInk(config.accentColor),
    "--salon-page-background": config.backgroundColor,
    "--salon-page-ink": readableInk(config.backgroundColor),
    "--salon-button-radius": radiusTokens[config.buttonRadius],
    "--salon-font-heading": fontTokens[config.typography],
    "--salon-accent-width": accentTokens[config.accentStyle],
    "--salon-color-scheme": config.mode,
  };
}
