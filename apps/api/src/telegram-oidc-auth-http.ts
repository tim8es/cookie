import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";

import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import {
  exchangeTrustedTelegramUser,
  linkTrustedTelegramUser,
  reserveEmailLoginAttempt,
  type EmailLoginLimits,
  type IdentitySessions,
} from "../../../packages/platform-identity/src/index.js";
import type { createTelegramOidcProvider } from "../../../packages/platform-identity/src/index.js";

const COOKIE_NAME = "cookie_tg_oidc";
const STATE_TTL_SECONDS = 300;
const IDENTITY_TOKEN = /^is_[A-Za-z0-9_-]{43}$/;

type TelegramOidcProvider = ReturnType<typeof createTelegramOidcProvider>;
type Intent = "login" | "register" | "link";
type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

interface StatePayload {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly intent: Intent;
  readonly expiresAt: number;
  readonly identityToken?: string;
  readonly identitySessionExpiresAt?: number;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
}

function sealState(key: Buffer, state: StatePayload): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("cookie-telegram-oidc-state-v1", "utf8"));
  const body = Buffer.from(JSON.stringify(state), "utf8");
  try {
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString(
      "base64url",
    );
  } finally {
    body.fill(0);
  }
}

function openState(key: Buffer, value: string): StatePayload | null {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  const sealed = Buffer.from(value, "base64url");
  if (sealed.toString("base64url") !== value || sealed.length < 30) return null;
  const plaintext: Buffer[] = [];
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      sealed.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from("cookie-telegram-oidc-state-v1", "utf8"));
    decipher.setAuthTag(sealed.subarray(12, 28));
    plaintext.push(decipher.update(sealed.subarray(28)), decipher.final());
    const body = Buffer.concat(plaintext);
    try {
      const parsed: unknown = JSON.parse(body.toString("utf8"));
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !Object.hasOwn(parsed, "state") ||
        !Object.hasOwn(parsed, "nonce") ||
        !Object.hasOwn(parsed, "verifier") ||
        !Object.hasOwn(parsed, "intent") ||
        !Object.hasOwn(parsed, "expiresAt")
      ) {
        return null;
      }
      const candidate = parsed as Record<string, unknown>;
      if (
        typeof candidate.state !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(candidate.state) ||
        typeof candidate.nonce !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(candidate.nonce) ||
        typeof candidate.verifier !== "string" ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(candidate.verifier) ||
        !["login", "register", "link"].includes(String(candidate.intent)) ||
        typeof candidate.expiresAt !== "number" ||
        !Number.isSafeInteger(candidate.expiresAt) ||
        (candidate.identityToken !== undefined &&
          (typeof candidate.identityToken !== "string" ||
            !IDENTITY_TOKEN.test(candidate.identityToken) ||
            typeof candidate.identitySessionExpiresAt !== "number" ||
            !Number.isSafeInteger(candidate.identitySessionExpiresAt)))
      ) {
        return null;
      }
      return candidate as unknown as StatePayload;
    } finally {
      body.fill(0);
    }
  } catch {
    return null;
  } finally {
    sealed.fill(0);
    for (const part of plaintext) part.fill(0);
  }
}

function readCookie(header: string | undefined): string | null {
  if (!header || header.length > 8192) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const prefix = COOKIE_NAME + "=";
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

function cookieHeader(value: string, maxAge: number): string {
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function sameOrigin(
  requestOrigin: string | undefined,
  expectedOrigin: string,
): boolean {
  return requestOrigin === expectedOrigin;
}

export interface TelegramOidcAuthDependencies {
  readonly pool: Pool;
  readonly provider: TelegramOidcProvider;
  readonly redirectUri: string;
  readonly fingerprintSecret: Buffer;
  readonly stateCookieKey: Buffer;
  readonly identitySessionProviders: readonly IdentitySessions[];
  readonly requestLimits: EmailLoginLimits;
}

export function registerTelegramOidcAuth(
  app: FastifyInstance,
  dependencies: TelegramOidcAuthDependencies,
): void {
  if (
    !Buffer.isBuffer(dependencies.fingerprintSecret) ||
    dependencies.fingerprintSecret.length < 32 ||
    !Buffer.isBuffer(dependencies.stateCookieKey) ||
    dependencies.stateCookieKey.length !== 32 ||
    dependencies.identitySessionProviders.length === 0
  ) {
    throw new Error("Invalid Telegram OIDC runtime configuration");
  }
  const cookieKey = Buffer.from(dependencies.stateCookieKey);
  const fingerprintSecret = Buffer.from(dependencies.fingerprintSecret);
  const redirectOrigin = new URL(dependencies.redirectUri).origin;
  const transaction: Transaction = (work) =>
    runSqlTransaction(dependencies.pool, work);

  const start = async (
    request: FastifyRequest,
    reply: FastifyReply,
    intent: Intent,
    identityToken?: string,
    identitySessionExpiresAt?: number,
  ) => {
    noStore(reply);
    if (!sameOrigin(request.headers.origin, redirectOrigin))
      return reply.code(403).send({ error: "FORBIDDEN" });

    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const stateHash = createHash("sha256").update(state).digest();
    const nonceHash = createHash("sha256").update(nonce).digest();
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const source = createHmac("sha256", cookieKey)
      .update("cookie-telegram-oidc-source-v1\0", "utf8")
      .update(request.ip, "utf8")
      .digest();

    let operation: "reserve-source" | "cleanup-expired-state" | "insert-state" =
      "reserve-source";
    try {
      const admitted = await transaction(async (client) => {
        const admission = await reserveEmailLoginAttempt(
          (work) => work(client),
          dependencies.requestLimits,
          source,
          null,
        );
        if (!admission) return false;
        operation = "cleanup-expired-state";
        await client.query(
          `WITH expired AS (
             SELECT state_sha256
             FROM cookie_identity.telegram_oidc_authorizations
             WHERE expires_at<=clock_timestamp() OR consumed_at IS NOT NULL
             ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
           )
           DELETE FROM cookie_identity.telegram_oidc_authorizations AS oidc_state
           USING expired WHERE oidc_state.state_sha256=expired.state_sha256`,
        );
        operation = "insert-state";
        await client.query(
          `INSERT INTO cookie_identity.telegram_oidc_authorizations
             (state_sha256,nonce_sha256,expires_at)
           VALUES($1,$2,clock_timestamp()+$3::integer*interval '1 second')`,
          [stateHash, nonceHash, STATE_TTL_SECONDS],
        );
        return true;
      });
      if (!admitted) return reply.code(429).send({ error: "TRY_AGAIN_LATER" });
      const statePayload: StatePayload = {
        state,
        nonce,
        verifier,
        intent,
        expiresAt: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
        ...(identityToken && identitySessionExpiresAt
          ? { identityToken, identitySessionExpiresAt }
          : {}),
      };
      reply.header(
        "Set-Cookie",
        cookieHeader(sealState(cookieKey, statePayload), STATE_TTL_SECONDS),
      );
      return reply.send({
        authorizationUrl: dependencies.provider.authorizationUrl({
          state,
          nonce,
          codeChallenge: challenge,
        }),
      });
    } catch (reason) {
      const code =
        typeof reason === "object" &&
        reason !== null &&
        "code" in reason &&
        typeof reason.code === "string" &&
        /^[A-Z0-9_]{1,32}$/.test(reason.code)
          ? reason.code
          : "UNKNOWN";
      const position =
        typeof reason === "object" &&
        reason !== null &&
        "position" in reason &&
        typeof reason.position === "string" &&
        /^\d{1,6}$/.test(reason.position)
          ? Number(reason.position)
          : undefined;
      request.log.warn(
        { code, operation, position },
        "Telegram OIDC state reservation failed",
      );
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    } finally {
      source.fill(0);
      stateHash.fill(0);
      nonceHash.fill(0);
    }
  };

  app.post("/v1/auth/telegram/oidc/start", async (request, reply) => {
    const body: unknown = request.body;
    if (
      !exactObject(body, ["intent"]) ||
      (body.intent !== "login" && body.intent !== "register")
    ) {
      noStore(reply);
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    return start(request, reply, body.intent);
  });

  app.post("/v1/auth/telegram/oidc/link/start", async (request, reply) => {
    const token = /^Bearer (is_[A-Za-z0-9_-]{43})$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!token) {
      noStore(reply);
      return reply.code(401).send({ error: "UNAUTHENTICATED" });
    }
    let identityId: string | null = null;
    let expiresAtUnixSeconds: number | undefined;
    try {
      for (const provider of dependencies.identitySessionProviders) {
        const session = await provider.resolveWithExpiry(token);
        if (session) {
          identityId = session.identityId;
          expiresAtUnixSeconds = session.expiresAtUnixSeconds;
          break;
        }
      }
    } catch {
      noStore(reply);
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
    if (!identityId) {
      noStore(reply);
      return reply.code(401).send({ error: "UNAUTHENTICATED" });
    }
    return start(request, reply, "link", token, expiresAtUnixSeconds);
  });

  app.post("/v1/auth/telegram/oidc/complete", async (request, reply) => {
    noStore(reply);
    reply.header("Set-Cookie", cookieHeader("", 0));
    if (!sameOrigin(request.headers.origin, redirectOrigin))
      return reply.code(403).send({ error: "FORBIDDEN" });
    const body: unknown = request.body;
    const sealed = readCookie(request.headers.cookie);
    const payload = sealed ? openState(cookieKey, sealed) : null;
    if (
      !exactObject(body, ["code", "state"]) ||
      typeof body.code !== "string" ||
      typeof body.state !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.state) ||
      !payload ||
      payload.expiresAt <= Math.floor(Date.now() / 1000) ||
      !timingSafeEqual(Buffer.from(body.state), Buffer.from(payload.state))
    ) {
      return reply.code(401).send({ error: "UNAUTHENTICATED" });
    }

    const stateHash = createHash("sha256").update(payload.state).digest();
    const nonceHash = createHash("sha256").update(payload.nonce).digest();
    try {
      const consumed = await transaction(async (client) => {
        const result = await client.query(
          `UPDATE cookie_identity.telegram_oidc_authorizations
           SET consumed_at=clock_timestamp()
           WHERE state_sha256=$1 AND nonce_sha256=$2
             AND consumed_at IS NULL AND expires_at>clock_timestamp()
           RETURNING state_sha256`,
          [stateHash, nonceHash],
        );
        return result.rowCount === 1;
      });
      if (!consumed) return reply.code(401).send({ error: "UNAUTHENTICATED" });

      const verified = await dependencies.provider.exchangeCode({
        code: body.code,
        codeVerifier: payload.verifier,
        nonce: payload.nonce,
      });
      const exchangeHash = createHash("sha256")
        .update("telegram-oidc-exchange-v1\0", "utf8")
        .update(stateHash)
        .digest();
      if (payload.intent === "link") {
        const linked = await linkTrustedTelegramUser(
          transaction,
          dependencies.identitySessionProviders,
          fingerprintSecret,
          verified.telegramUserId,
          exchangeHash,
          payload.identityToken,
        );
        return linked
          ? reply.code(200).send({
              tokenType: "Bearer",
              accessToken: payload.identityToken,
              scope: "identity",
              expiresAtUnixSeconds: payload.identitySessionExpiresAt,
            })
          : reply.code(409).send({ error: "TELEGRAM_LINK_CONFLICT" });
      }
      const session = await exchangeTrustedTelegramUser(
        transaction,
        fingerprintSecret,
        verified.telegramUserId,
        exchangeHash,
        payload.intent === "register",
        900,
      );
      if (!session) return reply.code(401).send({ error: "UNAUTHENTICATED" });
      return reply.code(200).send({
        tokenType: "Bearer",
        accessToken: session.token,
        scope: "identity",
        expiresAtUnixSeconds: session.expiresAtUnixSeconds,
      });
    } catch {
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    } finally {
      stateHash.fill(0);
      nonceHash.fill(0);
    }
  });
}
