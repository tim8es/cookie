/**
 * Public F1 policy capability used by internal business commands.
 * Caller MUST hold its trusted PostgreSQL transaction and preserve lock order.
 * Authentication/issuer verification remains owned by Identity.
 */
export {
  AuthorizationDeniedError,
  type TrustedActor,
} from "./authorization.js";
export { requireTenantPermission } from "./postgres.js";

/** Real opt-in Telegram session composition; no operator provisioning export. */
export { PostgresOpaqueTelegramSessions } from "./opaque-sessions.js";
export { IdentitySessions } from "./identity-sessions.js";
export { createTelegramMiniAppProofVerifier } from "./telegram-init-data.js";
export { createPostgresVerifiedTelegramLinkResolver } from "./telegram-links.js";
export { lockTelegramUser } from "./telegram-links.js";
export {
  exchangeSelfServiceTelegram,
  linkSelfServiceTelegram,
} from "./telegram-self-registration.js";
export type { TelegramMiniAppProofVerifier } from "./telegram-init-data.js";
export { telegramUserFingerprint } from "./telegram-links.js";
