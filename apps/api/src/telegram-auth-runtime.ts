import type { Pool } from "pg";

import {
  IdentitySessions,
  PostgresOpaqueTelegramSessions,
  createTelegramMiniAppProofVerifier,
  createPostgresVerifiedTelegramLinkResolver,
} from "../../../packages/platform-identity/src/index.js";
import type { TelegramIdentityAuthDependencies } from "./telegram-identity-auth-http.js";

/**
 * A disabled auth provider exposes NO login endpoint; configuration mistakes
 * fail startup instead of silently accepting untrusted test credentials.
 * The origin is the public HTTPS edge; TLS termination is operationally
 * verified before any real Telegram/PII traffic.
 */
export function createLiveTelegramSessionProvider(
  env: NodeJS.ProcessEnv,
  pool: Pool,
): PostgresOpaqueTelegramSessions | null {
  const flag = env.COOKIE_TELEGRAM_AUTH_MODE;
  if (flag === undefined) return null;
  if (flag !== "enabled") {
    throw new Error("Invalid COOKIE_TELEGRAM_AUTH_MODE");
  }
  const secretHex = env.COOKIE_TELEGRAM_USER_HMAC_SECRET ?? "";
  if (!/^[0-9a-f]{64}$/i.test(secretHex)) {
    throw new Error("COOKIE_TELEGRAM_USER_HMAC_SECRET must be 32-byte hex");
  }

  let origin: URL;
  try {
    origin = new URL(env.COOKIE_PUBLIC_ORIGIN ?? "");
  } catch {
    throw new Error("Cookie Telegram AuthN requires a configured HTTPS origin");
  }
  if (
    origin.protocol !== "https:" ||
    !origin.hostname ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    throw new Error("Cookie Telegram AuthN requires an HTTPS origin");
  }

  const proof = createTelegramMiniAppProofVerifier({
    botToken: env.COOKIE_TELEGRAM_BOT_TOKEN ?? "",
    maxAgeSeconds: 300,
    maxFutureSkewSeconds: 30,
  });
  const resolveVerifiedTelegramLink =
    createPostgresVerifiedTelegramLinkResolver({
      userHashSecret: Buffer.from(secretHex, "hex"),
    });
  return new PostgresOpaqueTelegramSessions({
    pool,
    telegramProofVerifier: proof,
    fingerprintSecret: Buffer.from(secretHex, "hex"),
    resolveVerifiedTelegramLink,
    issuer: "cookie-telegram",
    audience: "cookie-web",
    ttlSeconds: 900,
  });
}

export function createLiveTelegramIdentityAuth(
  env: NodeJS.ProcessEnv,
  pool: Pool,
  legacySessions?: PostgresOpaqueTelegramSessions,
  additionalIdentitySessionProviders: readonly IdentitySessions[] = [],
): TelegramIdentityAuthDependencies | null {
  const flag = env.COOKIE_TELEGRAM_SELF_REGISTRATION_MODE;
  if (flag === undefined) return null;
  if (flag !== "enabled")
    throw new Error("Invalid COOKIE_TELEGRAM_SELF_REGISTRATION_MODE");
  const secretHex = env.COOKIE_TELEGRAM_USER_HMAC_SECRET ?? "";
  if (!/^[0-9a-f]{64}$/i.test(secretHex))
    throw new Error("COOKIE_TELEGRAM_USER_HMAC_SECRET must be 32-byte hex");
  let origin: URL;
  try {
    origin = new URL(env.COOKIE_PUBLIC_ORIGIN ?? "");
  } catch {
    throw new Error("Cookie Telegram AuthN requires a configured HTTPS origin");
  }
  if (
    origin.protocol !== "https:" ||
    !origin.hostname ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    throw new Error("Cookie Telegram AuthN requires an HTTPS origin");
  }
  const verifier = createTelegramMiniAppProofVerifier({
    botToken: env.COOKIE_TELEGRAM_BOT_TOKEN ?? "",
    maxAgeSeconds: 300,
    maxFutureSkewSeconds: 30,
  });
  const telegramIdentitySessions = new IdentitySessions(
    pool,
    "cookie-telegram",
    "cookie-web",
    900,
  );
  return {
    pool,
    verifier,
    fingerprintSecret: Buffer.from(secretHex, "hex"),
    identitySessionProviders: [
      telegramIdentitySessions,
      ...additionalIdentitySessionProviders,
    ],
    legacySessions,
    ttlSeconds: 900,
  };
}
