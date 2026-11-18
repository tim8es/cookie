import {
  createPublicKey,
  createHash,
  timingSafeEqual,
  verify,
} from "node:crypto";

export interface TelegramOidcConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

interface Jwk {
  readonly kty?: unknown;
  readonly kid?: unknown;
  readonly use?: unknown;
  readonly alg?: unknown;
  readonly n?: unknown;
  readonly e?: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function decodeJson(value: string): unknown {
  if (
    value.length === 0 ||
    value.length > 16_384 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error("Invalid Telegram OIDC token");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Invalid Telegram OIDC token");
  }
  return JSON.parse(decoded.toString("utf8")) as unknown;
}

async function responseJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (
    !response.ok ||
    (Number.isFinite(length) && length > 32_768) ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    throw new Error("Telegram OIDC request failed");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Telegram OIDC response is empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > 32_768) {
      await reader.cancel();
      throw new Error("Telegram OIDC response is too large");
    }
    chunks.push(next.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function telegramUserId(value: unknown): string | null {
  if (typeof value === "string") {
    return /^[1-9][0-9]{0,15}$/.test(value) &&
      Number.isSafeInteger(Number(value))
      ? value
      : null;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null;
}

/** Telegram OIDC Authorization Code + PKCE client, pinned to RS256/JWKS. */
export function createTelegramOidcProvider(
  config: TelegramOidcConfig,
  fetcher: typeof fetch = globalThis.fetch,
): {
  authorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<{ telegramUserId: string }>;
} {
  let redirect: URL;
  try {
    redirect = new URL(config.redirectUri);
  } catch {
    throw new Error("Invalid Telegram OIDC redirect URI");
  }
  if (
    !/^[0-9]{1,32}$/.test(config.clientId) ||
    !config.clientSecret ||
    config.clientSecret.length > 512 ||
    redirect.protocol !== "https:" ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    redirect.pathname !== "/auth/telegram/callback"
  ) {
    throw new Error("Invalid Telegram OIDC configuration");
  }

  let cachedJwks: readonly Jwk[] | null = null;
  let jwksExpiresAt = 0;
  const jwks = async (refresh = false): Promise<readonly Jwk[]> => {
    if (!refresh && cachedJwks && Date.now() < jwksExpiresAt) return cachedJwks;
    const response = await fetcher(
      "https://oauth.telegram.org/.well-known/jwks.json",
      {
        method: "GET",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      },
    );
    const body = await responseJson(response);
    if (!record(body) || !Array.isArray(body.keys) || body.keys.length > 16) {
      throw new Error("Invalid Telegram OIDC keys");
    }
    cachedJwks = body.keys.filter(record) as Jwk[];
    jwksExpiresAt = Date.now() + 300_000;
    return cachedJwks;
  };

  return {
    authorizationUrl({ state, nonce, codeChallenge }) {
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(state) ||
        !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
        !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)
      ) {
        throw new Error("Invalid Telegram OIDC authorization state");
      }
      const url = new URL("https://oauth.telegram.org/auth");
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirect.href,
        response_type: "code",
        scope: "openid profile",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }).toString();
      return url.href;
    },

    async exchangeCode({ code, codeVerifier, nonce }) {
      if (
        typeof code !== "string" ||
        code.length < 1 ||
        code.length > 4096 ||
        !/^[A-Za-z0-9._~-]+$/.test(code) ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(codeVerifier) ||
        !/^[A-Za-z0-9_-]{43}$/.test(nonce)
      ) {
        throw new Error("Invalid Telegram OIDC authorization code");
      }
      const basic = Buffer.from(
        config.clientId + ":" + config.clientSecret,
        "utf8",
      ).toString("base64");
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect.href,
        client_id: config.clientId,
        code_verifier: codeVerifier,
      });
      const response = await fetcher("https://oauth.telegram.org/token", {
        method: "POST",
        headers: {
          authorization: "Basic " + basic,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      const tokens = await responseJson(response);
      if (!record(tokens) || typeof tokens.id_token !== "string") {
        throw new Error("Invalid Telegram OIDC token response");
      }

      const parts = tokens.id_token.split(".");
      if (parts.length !== 3) throw new Error("Invalid Telegram OIDC token");
      const [encodedHeader, encodedClaims, encodedSignature] = parts as [
        string,
        string,
        string,
      ];
      const header = decodeJson(encodedHeader);
      const claims = decodeJson(encodedClaims);
      if (
        !record(header) ||
        header.alg !== "RS256" ||
        typeof header.kid !== "string" ||
        header.kid.length > 256 ||
        !/^[A-Za-z0-9_-]+$/.test(encodedSignature) ||
        !record(claims)
      ) {
        throw new Error("Invalid Telegram OIDC token claims");
      }
      let key = (await jwks()).find(
        (candidate) =>
          candidate.kid === header.kid &&
          candidate.kty === "RSA" &&
          (candidate.use === undefined || candidate.use === "sig") &&
          (candidate.alg === undefined || candidate.alg === "RS256"),
      );
      if (!key) {
        key = (await jwks(true)).find(
          (candidate) =>
            candidate.kid === header.kid &&
            candidate.kty === "RSA" &&
            (candidate.use === undefined || candidate.use === "sig") &&
            (candidate.alg === undefined || candidate.alg === "RS256"),
        );
      }
      if (!key) throw new Error("Telegram OIDC signing key unavailable");
      const signature = Buffer.from(encodedSignature, "base64url");
      if (signature.toString("base64url") !== encodedSignature) {
        throw new Error("Invalid Telegram OIDC signature");
      }
      const signed = Buffer.from(encodedHeader + "." + encodedClaims, "ascii");
      const publicKey = createPublicKey({
        key: key as import("node:crypto").webcrypto.JsonWebKey,
        format: "jwk",
      });
      if (
        !verify("RSA-SHA256", signed, publicKey, signature) ||
        publicKey.asymmetricKeyType !== "rsa" ||
        (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      ) {
        throw new Error("Invalid Telegram OIDC signature");
      }

      const now = Math.floor(Date.now() / 1000);
      const audience = claims.aud;
      const audiences = typeof audience === "string" ? [audience] : audience;
      const expectedNonce = createHash("sha256").update(nonce).digest();
      const actualNonce =
        typeof claims.nonce === "string"
          ? createHash("sha256").update(claims.nonce).digest()
          : Buffer.alloc(expectedNonce.length);
      if (
        claims.iss !== "https://oauth.telegram.org" ||
        !Array.isArray(audiences) ||
        !audiences.includes(config.clientId) ||
        (audiences.length > 1 && claims.azp !== config.clientId) ||
        typeof claims.sub !== "string" ||
        claims.sub.length === 0 ||
        claims.sub.length > 128 ||
        typeof claims.iat !== "number" ||
        !Number.isSafeInteger(claims.iat) ||
        claims.iat > now + 30 ||
        now - claims.iat > 600 ||
        typeof claims.exp !== "number" ||
        !Number.isSafeInteger(claims.exp) ||
        claims.exp <= now ||
        claims.exp > now + 3600 ||
        !timingSafeEqual(expectedNonce, actualNonce)
      ) {
        throw new Error("Invalid Telegram OIDC identity claims");
      }
      const userId = telegramUserId(claims.id);
      if (!userId) throw new Error("Telegram OIDC profile is missing user ID");
      return { telegramUserId: userId };
    },
  };
}
