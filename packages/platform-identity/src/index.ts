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
  exchangeTrustedTelegramUser,
  exchangeSelfServiceTelegram,
  linkTrustedTelegramUser,
  linkSelfServiceTelegram,
} from "./telegram-self-registration.js";
export {
  createTelegramOidcProvider,
  TelegramOidcUpstreamError,
} from "./telegram-oidc.js";
export type { TelegramOidcConfig } from "./telegram-oidc.js";
export type { TelegramMiniAppProofVerifier } from "./telegram-init-data.js";
export { telegramUserFingerprint } from "./telegram-links.js";
export {
  completeEmailPasswordRecovery,
  purgeExpiredEmailRecoveryChallenges,
} from "./email-password-recovery.js";
export { completeEmailRegistration } from "./email-registration.js";
export { loginEmailPassword } from "./email-session-login.js";
export type { EmailLoginResult } from "./email-session-login.js";
export {
  completeEmailCredentialLink,
  issueEmailCredentialLinkChallenge,
  purgeExpiredEmailRegistrationChallenges,
} from "./email-credential-link.js";
export type { EmailLoginLimits } from "./email-login-throttle.js";
export {
  purgeExpiredEmailLoginAttempts,
  reserveEmailLoginAttempt,
} from "./email-login-throttle.js";
export { createAuthMailQueue } from "./auth-mail-queue.js";
export type { AuthMailLimits } from "./auth-mail-admission.js";
export { createAuthMailWorker } from "./auth-mail-worker.js";
export { createAltareEmailApiTransport } from "./altare-email-api-transport.js";
export type { AltareEmailApiConfig } from "./altare-email-api-transport.js";
export type {
  AuthMailLinkConfig,
  AuthMailTransport,
  AuthMailPurpose,
} from "./auth-mail-delivery.js";
export { createSendmailAuthTransport } from "./sendmail-auth-transport.js";
export { PasswordWorkBusy, PasswordWorkGate } from "./password-work-gate.js";
export {
  appendAuthIdentityAudit,
  purgeAuthSecurityEvents,
} from "./auth-security-audit.js";
export {
  provisionOwnerWorkspaceInTransaction,
  provisionOwnerWorkspace,
  OwnerWorkspaceProvisionError,
} from "./provision-owner-workspace.js";
export type {
  OwnerWorkspaceProvisionInput,
  OwnerWorkspaceProvisionResult,
} from "./provision-owner-workspace.js";


/** Trusted transaction-scoped policy port for manual outbox replay. */
export { authorizeOutboxReplay } from "./outbox-replay-policy.js";
