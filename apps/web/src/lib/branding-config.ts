/**
 * Web binding to the real Cookie domain-appearance public module.
 * No duplicate browser-side policy: the server must use the same validator.
 */
export {
  brandPresets,
  brandContrast,
  createBrandConfig,
  validateBrandConfig,
  compileBrandTokens,
} from "../../../../packages/domain-appearance/src/index.js";
export type {
  BrandPresetId,
  BrandColorMode,
  BrandButtonRadius,
  BrandTypography,
  BrandAccentStyle,
  BrandConfigV1,
  BrandPreset,
} from "../../../../packages/domain-appearance/src/index.js";

import {
  brandPresets,
  compileBrandTokens,
  createBrandConfig,
  type BrandPresetId,
} from "../../../../packages/domain-appearance/src/index.js";

/** Preview recovery only. Save and publish keep strict domain validation. */
export function safeBrandPresetId(value: unknown): BrandPresetId {
  return brandPresets.find((preset) => preset.id === value)?.id ?? "atelier";
}

export function compileBrandPreviewTokens(
  raw: unknown,
): Readonly<Record<string, string>> {
  try {
    return compileBrandTokens(raw);
  } catch {
    const presetId =
      raw && typeof raw === "object" && "presetId" in raw
        ? safeBrandPresetId(raw.presetId)
        : "atelier";
    return compileBrandTokens(createBrandConfig(presetId));
  }
}
