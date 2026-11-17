import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TelegramMiniAppProofVerifier } from "./telegram-init-data.js";
import type { IdentitySessions } from "./identity-sessions.js";
import { lockTelegramUser } from "./telegram-links.js";

/** Pre-organization Telegram exchange; the HTTP adapter has a separate opt-in gate. */
export async function exchangeSelfServiceTelegram(
  transaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>,
  verifier: TelegramMiniAppProofVerifier,
  fingerprintSecret: Buffer,
  rawInitData: unknown,
  register: boolean,
  ttlSeconds: number,
): Promise<{ token: string; expiresAtUnixSeconds: number } | null> {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600)
    throw new Error("Invalid session lifetime");
  if (typeof rawInitData !== "string" || typeof register !== "boolean")
    return null;
  const proof = verifier.verify(rawInitData);
  if (!proof || proof.channel !== "telegram-mini-app") return null;
  const hash = new URLSearchParams(rawInitData).get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  const exchangeHash = createHash("sha256")
    .update("telegram-initdata-exchange-v1\0")
    .update(hash.toLowerCase())
    .digest();

  return transaction(async (client) => {
    const fingerprint = await lockTelegramUser(
      client,
      fingerprintSecret,
      proof.telegramUserId,
    );
    const currentProof = verifier.verify(rawInitData);
    if (
      !currentProof ||
      currentProof.channel !== proof.channel ||
      currentProof.telegramUserId !== proof.telegramUserId ||
      currentProof.authDateUnixSeconds !== proof.authDateUnixSeconds
    )
      return null;
    const legacy = await client.query(
      "SELECT 1 FROM cookie_identity.telegram_identity_links WHERE telegram_user_hmac_sha256=$1 LIMIT 1",
      [fingerprint],
    );
    if (legacy.rowCount) return null;
    const legacyProof = await client.query(
      "SELECT 1 FROM cookie_identity.opaque_sessions WHERE telegram_exchange_sha256=$1 LIMIT 1",
      [exchangeHash],
    );
    if (legacyProof.rowCount) return null;
    const priorExchange = await client.query(
      "SELECT 1 FROM cookie_identity.global_telegram_exchanges WHERE proof_sha256=$1 LIMIT 1",
      [exchangeHash],
    );
    if (priorExchange.rowCount) return null;
    const link = await client.query<{ identity_id: string }>(
      "SELECT identity_id::text FROM cookie_identity.global_telegram_identities WHERE telegram_user_hmac_sha256=$1",
      [fingerprint],
    );
    let identityId = link.rows[0]?.identity_id;
    if (!identityId) {
      if (!register) return null;
      identityId = randomUUID();
      await client.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid)",
        [identityId],
      );
      await client.query(
        "INSERT INTO cookie_identity.global_telegram_identities(telegram_user_hmac_sha256,identity_id) VALUES($1,$2::uuid)",
        [fingerprint, identityId],
      );
    }
    const consumed = await client.query(
      "INSERT INTO cookie_identity.global_telegram_exchanges(proof_sha256,identity_id) VALUES($1,$2::uuid) ON CONFLICT DO NOTHING RETURNING identity_id",
      [exchangeHash, identityId],
    );
    if (consumed.rowCount !== 1) return null;
    const token = "is_" + randomBytes(32).toString("base64url");
    const issued = await client.query<{ expires_at: Date }>(
      `INSERT INTO cookie_identity.identity_sessions(token_sha256,identity_id,issuer,audience,issued_at,expires_at)
      VALUES ($1,$2::uuid,'cookie-telegram','cookie-web',clock_timestamp(),clock_timestamp()+$3::integer*interval '1 second') RETURNING expires_at`,
      [createHash("sha256").update(token).digest(), identityId, ttlSeconds],
    );
    const expires = issued.rows[0]?.expires_at;
    if (!(expires instanceof Date) || !Number.isFinite(expires.getTime()))
      throw new Error("Session creation failed");
    return {
      token,
      expiresAtUnixSeconds: Math.floor(expires.getTime() / 1000),
    };
  });
}

/** Attach a Telegram proof to the already-authenticated pre-organization Identity. */
export async function linkSelfServiceTelegram(
  transaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>,
  sessionProviders: readonly IdentitySessions[],
  verifier: TelegramMiniAppProofVerifier,
  fingerprintSecret: Buffer,
  rawInitData: unknown,
  bearerToken: unknown,
): Promise<boolean> {
  if (
    !sessionProviders.length ||
    typeof rawInitData !== "string" ||
    Buffer.byteLength(rawInitData, "utf8") > 8192
  )
    return false;
  const proof = verifier.verify(rawInitData);
  if (!proof || proof.channel !== "telegram-mini-app") return false;
  const hash = new URLSearchParams(rawInitData).get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return false;
  const exchangeHash = createHash("sha256")
    .update("telegram-initdata-exchange-v1\0")
    .update(hash.toLowerCase())
    .digest();

  return transaction(async (client) => {
    let identityId: string | null = null;
    for (const provider of sessionProviders) {
      identityId = await provider.resolveWithinTransaction(client, bearerToken);
      if (identityId) break;
    }
    if (!identityId) return false;
    const identity = await client.query(
      "SELECT id FROM cookie_identity.identities WHERE id=$1::uuid FOR UPDATE",
      [identityId],
    );
    if (identity.rowCount !== 1) return false;

    const fingerprint = await lockTelegramUser(
      client,
      fingerprintSecret,
      proof.telegramUserId,
    );
    const currentProof = verifier.verify(rawInitData);
    if (
      !currentProof ||
      currentProof.channel !== proof.channel ||
      currentProof.telegramUserId !== proof.telegramUserId ||
      currentProof.authDateUnixSeconds !== proof.authDateUnixSeconds
    )
      return false;

    const legacyLink = await client.query(
      "SELECT 1 FROM cookie_identity.telegram_identity_links WHERE telegram_user_hmac_sha256=$1::bytea LIMIT 1",
      [fingerprint],
    );
    if (legacyLink.rowCount) return false;
    const legacyExchange = await client.query(
      "SELECT 1 FROM cookie_identity.opaque_sessions WHERE telegram_exchange_sha256=$1::bytea LIMIT 1",
      [exchangeHash],
    );
    if (legacyExchange.rowCount) return false;
    const priorExchange = await client.query(
      "SELECT 1 FROM cookie_identity.global_telegram_exchanges WHERE proof_sha256=$1::bytea LIMIT 1",
      [exchangeHash],
    );
    if (priorExchange.rowCount) return false;

    const identityLink = await client.query<{
      telegram_user_hmac_sha256: Buffer;
    }>(
      `SELECT telegram_user_hmac_sha256
         FROM cookie_identity.global_telegram_identities
        WHERE identity_id=$1::uuid FOR UPDATE`,
      [identityId],
    );
    const linkedFingerprint = identityLink.rows[0]?.telegram_user_hmac_sha256;
    if (linkedFingerprint && !linkedFingerprint.equals(fingerprint))
      return false;

    const telegramLink = await client.query<{ identity_id: string }>(
      `SELECT identity_id::text
         FROM cookie_identity.global_telegram_identities
        WHERE telegram_user_hmac_sha256=$1::bytea FOR UPDATE`,
      [fingerprint],
    );
    if (telegramLink.rows[0] && telegramLink.rows[0].identity_id !== identityId)
      return false;
    if (!telegramLink.rows[0]) {
      await client.query(
        `INSERT INTO cookie_identity.global_telegram_identities
           (telegram_user_hmac_sha256,identity_id)
         VALUES($1::bytea,$2::uuid)`,
        [fingerprint, identityId],
      );
    }
    const consumed = await client.query(
      `INSERT INTO cookie_identity.global_telegram_exchanges
         (proof_sha256,identity_id)
       VALUES($1::bytea,$2::uuid) ON CONFLICT DO NOTHING RETURNING identity_id`,
      [exchangeHash, identityId],
    );
    return consumed.rowCount === 1;
  });
}
