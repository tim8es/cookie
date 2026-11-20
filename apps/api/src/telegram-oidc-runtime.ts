import type { Pool } from "pg";

import {
  createTelegramOidcProvider,
  IdentitySessions,
  type EmailLoginLimits,
} from "../../../packages/platform-identity/src/index.js";
import type { TelegramOidcAuthDependencies } from "./telegram-oidc-auth-http.js";

export interface LiveTelegramOidcAuth {
  readonly sessions: IdentitySessions;
  readonly routes: Omit<
    TelegramOidcAuthDependencies,
    "identitySessionProviders"
  >;
}

function secret(env: NodeJS.ProcessEnv, name: string): Buffer {
  const value = env[name] ?? "";
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${name} must be 32-byte hex`);
  }
  return Buffer.from(value, "hex");
}

export function createLiveTelegramOidcAuth(
  env: NodeJS.ProcessEnv,
  pool: Pool,
  telegramSessions?: IdentitySessions,
): LiveTelegramOidcAuth | null {
  const mode = env.COOKIE_TELEGRAM_OIDC_MODE;
  if (mode === undefined) return null;
  if (mode !== "enabled") throw new Error("Invalid COOKIE_TELEGRAM_OIDC_MODE");

  const publicOrigin = env.COOKIE_PUBLIC_ORIGIN ?? "";
  const clientId = env.COOKIE_TELEGRAM_OIDC_CLIENT_ID ?? "";
  const clientSecret = env.COOKIE_TELEGRAM_OIDC_CLIENT_SECRET ?? "";
  const redirectUri = env.COOKIE_TELEGRAM_OIDC_REDIRECT_URI ?? "";
  let origin: URL;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new Error("Telegram OIDC requires COOKIE_PUBLIC_ORIGIN");
  }
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw new Error("Invalid COOKIE_TELEGRAM_OIDC_REDIRECT_URI");
  }
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    redirect.origin !== origin.origin
  ) {
    throw new Error("Telegram OIDC requires an HTTPS same-origin callback");
  }

  const fingerprintSecret = secret(env, "COOKIE_TELEGRAM_USER_HMAC_SECRET");
  const stateCookieKey = secret(env, "COOKIE_TELEGRAM_OIDC_COOKIE_KEY");
  const provider = createTelegramOidcProvider({
    clientId,
    clientSecret,
    redirectUri,
  });
  const sessions =
    telegramSessions ??
    new IdentitySessions(pool, "cookie-telegram", "cookie-web", 900);
  const requestLimits: EmailLoginLimits = {
    windowSeconds: 900,
    accountAttempts: 20,
    sourceAttempts: 20,
  };
  return {
    sessions,
    routes: {
      pool,
      provider,
      redirectUri,
      fingerprintSecret,
      stateCookieKey,
      requestLimits,
    },
  };
}
