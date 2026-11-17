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
