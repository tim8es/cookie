import type { Pool } from "pg";

import { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import { createPostgresVerifiedTelegramLinkResolver } from "../../../packages/platform-identity/src/telegram-links.js";

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
  const resolveVerifiedTelegramLink = createPostgresVerifiedTelegramLinkResolver({
    userHashSecret: Buffer.from(secretHex, "hex"),
  });
  return new PostgresOpaqueTelegramSessions({
    pool,
    telegramProofVerifier: proof,
    resolveVerifiedTelegramLink,
    issuer: "cookie-telegram",
    audience: "cookie-web",
    ttlSeconds: 900,
  });
}
