/** Cookie Appearance module: portable validated public configuration. */
export {
  brandPresets,
  brandContrast,
  createBrandConfig,
  validateBrandConfig,
  compileBrandTokens,
} from "./branding.js";
export type {
  BrandPresetId,
  BrandColorMode,
  BrandButtonRadius,
  BrandTypography,
  BrandAccentStyle,
  BrandConfigV1,
  BrandPreset,
} from "./branding.js";

/** Persistent Appearance capability. Caller owns transaction and AuthZ. */
export {
  AppearanceAssetNotVerified,
  AppearanceRevisionConflict,
  readTenantBrandDraft,
  readAppearanceRevisionState,
  saveTenantBrandDraft,
  publishTenantBrandDraft,
  readPublishedTenantBrand,
} from "./postgres.js";
export type {
  AppearanceDraft,
  AppearancePublished,
  AssetKind,
  TenantAssetOwnership,
} from "./postgres.js";
export { recordAppearancePublicationAudit } from "./publication-audit.js";
