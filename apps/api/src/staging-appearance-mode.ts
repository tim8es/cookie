import { parseStagingPublicationMode } from "../../../packages/domain-entitlement/src/index.js";

/**
 * The controlled Appearance publish API is an independent, explicit opt-in
 * inside an already-enabled private staging runtime. Neither the general
 * staging switch nor an Appearance DB grant alone activates these routes.
 * This is infrastructure gating, not the salon's configurable business policy.
 */
export function parseControlledAppearanceMode(
  appearanceMode: string | undefined,
  stagingPublicationEnabled: boolean,
): boolean {
  const enabled = parseStagingPublicationMode(appearanceMode);
  if (enabled && !stagingPublicationEnabled) {
    throw new Error("Appearance staging requires staging publication mode");
  }
  return enabled;
}
