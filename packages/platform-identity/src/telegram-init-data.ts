import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verified Telegram channel proof, NOT a Cookie Identity, Membership, Customer
 * or authenticated Cookie session. The caller must perform trusted account
 * linking and issue a separate revocable Cookie session after this check.
 */
export interface VerifiedTelegramMiniAppProof {
  readonly channel: "telegram-mini-app";
  readonly telegramUserId: string;
  readonly authDateUnixSeconds: number;
}

export interface TelegramMiniAppVerifierConfig {
  /** Server-only secret for the exact Mini App bot; never expose to the web. */
  readonly botToken: string;
  /** Explicit upper bound on how long a Telegram launch proof is accepted. */
  readonly maxAgeSeconds: number;
  /** Optional clock skew; default 30 seconds, hard capped at 60. */
  readonly maxFutureSkewSeconds?: number;
  /** Testable server clock, NEVER read from an HTTP request. */
  readonly nowUnixSeconds?: () => number;
}

export interface TelegramMiniAppProofVerifier {
  verify(rawInitData: unknown): VerifiedTelegramMiniAppProof | null;
}

const MAX_INIT_DATA_BYTES = 8_192;
const MAX_FIELDS = 32;
const TOKEN = /^[0-9]{1,20}:[A-Za-z0-9_-]{10,}$/;
const FIELD = /^[a-z][a-z0-9_]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const UINT = /^(0|[1-9][0-9]*)$/;

function decodeFormPart(value: string): string | null {
  try {
    // application/x-www-form-urlencoded defines '+' as a space.
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    // Invalid %-encoding or invalid UTF-8 must never be repaired silently.
    return null;
  }
}

function parseFields(raw: unknown): Map<string, string> | null {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    Buffer.byteLength(raw, "utf8") > MAX_INIT_DATA_BYTES ||
    raw.startsWith("?") ||
    raw.includes("#")
  ) {
    return null;
  }
  const fragments = raw.split("&");
  if (fragments.length > MAX_FIELDS) return null;
  const fields = new Map<string, string>();
  for (const fragment of fragments) {
    const equals = fragment.indexOf("=");
    if (equals < 1) return null;
    const key = decodeFormPart(fragment.slice(0, equals));
    const value = decodeFormPart(fragment.slice(equals + 1));
    if (!key || !FIELD.test(key) || value === null || fields.has(key)) {
      return null;
    }
    fields.set(key, value);
  }
  return fields;
}

/**
 * Telegram bot-owner HMAC validation of raw WebApp.initData.
 *
 * For bot-owner HMAC verification, Telegram requires all received fields
 * except "hash" in the data-check string, INCLUDING optional "signature".
 * Only the separate third-party Ed25519 verification algorithm omits both
 * "hash" and "signature". The Ed25519 value is not itself a Cookie credential.
 * No field is trusted or logged before authentication succeeds.
 *
 * Deliberately DOES NOT implement a login endpoint, grant access, infer a
 * tenantId, or bind a Telegram account to a Customer from unverified input.
 */
export function createTelegramMiniAppProofVerifier(
  config: TelegramMiniAppVerifierConfig,
): TelegramMiniAppProofVerifier {
  if (
    !TOKEN.test(config.botToken) ||
    !Number.isSafeInteger(config.maxAgeSeconds) ||
    config.maxAgeSeconds < 1 ||
    config.maxAgeSeconds > 3_600
  ) {
    throw new Error("Invalid Telegram verifier configuration");
  }
  const skew = config.maxFutureSkewSeconds ?? 30;
  if (!Number.isSafeInteger(skew) || skew < 0 || skew > 60) {
    throw new Error("Invalid Telegram verifier clock skew");
  }

  const now = config.nowUnixSeconds ?? (() => Math.floor(Date.now() / 1000));
  const secret = createHmac("sha256", "WebAppData")
    .update(config.botToken, "utf8")
    .digest();

  return {
    verify(rawInitData) {
      const fields = parseFields(rawInitData);
      if (!fields) return null;

      const hash = fields.get("hash");
      const authDate = fields.get("auth_date");
      const userJson = fields.get("user");
      if (
        !hash ||
        !SHA256_HEX.test(hash) ||
        !authDate ||
        !UINT.test(authDate) ||
        !userJson
      ) {
        return null;
      }

      // Sort strictly by ASCII field name; never re-serialize user JSON.
      const check = [...fields.entries()]
        .filter(([key]) => key !== "hash")
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");

      const expected = createHmac("sha256", secret)
        .update(check, "utf8")
        .digest();
      const received = Buffer.from(hash, "hex");
      if (
        received.length !== expected.length ||
        !timingSafeEqual(expected, received)
      ) {
        return null;
      }

      const timestamp = Number(authDate);
      const current = now();
      if (
        !Number.isSafeInteger(timestamp) ||
        timestamp < 1 ||
        !Number.isSafeInteger(current) ||
        current < 1 ||
        timestamp > current + skew ||
        current - timestamp > config.maxAgeSeconds
      ) {
        return null;
      }

      let user: unknown;
      try {
        user = JSON.parse(userJson);
      } catch {
        return null;
      }
      if (
        typeof user !== "object" ||
        user === null ||
        Array.isArray(user) ||
        !("id" in user) ||
        !Number.isSafeInteger(user.id) ||
        typeof user.id !== "number" ||
        user.id <= 0
      ) {
        return null;
      }

      return {
        channel: "telegram-mini-app",
        telegramUserId: String(user.id),
        authDateUnixSeconds: timestamp,
      };
    },
  };
}
