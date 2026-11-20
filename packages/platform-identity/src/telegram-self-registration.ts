import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TelegramMiniAppProofVerifier } from "./telegram-init-data.js";
import type { IdentitySessions } from "./identity-sessions.js";
import { appendAuthIdentityAudit } from "./auth-security-audit.js";
import { lockTelegramUser } from "./telegram-links.js";

function validTelegramUserId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}

async function consumeGlobalTelegramProof(
  client: PoolClient,
  fingerprint: Buffer,
  exchangeHash: Buffer,
  register: boolean,
): Promise<{ identityId: string; createdIdentity: boolean } | null> {
  const legacy = await client.query(
    "SELECT 1 FROM cookie_identity.telegram_identity_links WHERE telegram_user_hmac_sha256=$1 LIMIT 1",
    [fingerprint],
  );
  // A historical legacy mapping remains a hard barrier except for an
  // explicitly migrated, exact, currently active source. Revocation of
  // that source also revokes issued Telegram identity sessions atomically.
  let migratedIdentity: string | undefined;
  if (legacy.rowCount) {
    const migrated = await client.query<{ identity_id: string }>(
      `SELECT g.identity_id::text
       FROM cookie_identity.global_telegram_identities g
       JOIN cookie_identity.telegram_identity_links l
         ON l.tenant_id=g.legacy_tenant_id AND l.identity_id=g.identity_id
         AND l.id=g.legacy_link_id
       JOIN cookie_identity.memberships m
         ON m.tenant_id=l.tenant_id AND m.identity_id=l.identity_id
       WHERE g.telegram_user_hmac_sha256=$1::bytea
         AND l.telegram_user_hmac_sha256=$1::bytea
         AND g.migration_request_id IS NOT NULL AND g.legacy_revoked_at IS NULL
         AND l.revoked_at IS NULL AND m.active
       FOR SHARE OF g,l,m NOWAIT`,
      [fingerprint],
    );
    migratedIdentity = migrated.rows[0]?.identity_id;
    if (!migratedIdentity) return null;
  }
  const priorExchange = await client.query(
    "SELECT 1 FROM cookie_identity.global_telegram_exchanges WHERE proof_sha256=$1 LIMIT 1",
    [exchangeHash],
  );
  if (priorExchange.rowCount) return null;
  const link = await client.query<{
    identity_id: string;
    legacy_link_id: string | null;
    legacy_revoked_at: Date | null;
  }>(
    "SELECT identity_id::text,legacy_link_id::text,legacy_revoked_at FROM cookie_identity.global_telegram_identities WHERE telegram_user_hmac_sha256=$1",
    [fingerprint],
  );
  const mapping = link.rows[0];
  let identityId = mapping?.identity_id;
  if (
    (mapping?.legacy_link_id && migratedIdentity !== identityId) ||
    mapping?.legacy_revoked_at ||
    (migratedIdentity && identityId !== migratedIdentity)
  )
    return null;
  let createdIdentity = false;
  if (!identityId) {
    if (!register) return null;
    identityId = randomUUID();
    createdIdentity = true;
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
  return { identityId, createdIdentity };
}

async function issueGlobalTelegramSession(
  client: PoolClient,
  fingerprint: Buffer,
  exchangeHash: Buffer,
  register: boolean,
  ttlSeconds: number,
): Promise<{ token: string; expiresAtUnixSeconds: number } | null> {
  const accepted = await consumeGlobalTelegramProof(
    client,
    fingerprint,
    exchangeHash,
    register,
  );
  if (!accepted) return null;
  const { identityId, createdIdentity } = accepted;
  const token = "is_" + randomBytes(32).toString("base64url");
  const issued = await client.query<{ expires_at: Date }>(
    `INSERT INTO cookie_identity.identity_sessions(token_sha256,identity_id,issuer,audience,issued_at,expires_at)
     VALUES ($1,$2::uuid,'cookie-telegram','cookie-web',clock_timestamp(),clock_timestamp()+$3::integer*interval '1 second')
     RETURNING expires_at`,
    [createHash("sha256").update(token).digest(), identityId, ttlSeconds],
  );
  const expires = issued.rows[0]?.expires_at;
  if (!(expires instanceof Date) || !Number.isFinite(expires.getTime()))
    throw new Error("Session creation failed");
  await appendAuthIdentityAudit(
    client,
    createdIdentity ? "telegram_registered" : "telegram_login",
    identityId,
  );
  return { token, expiresAtUnixSeconds: Math.floor(expires.getTime() / 1000) };
}

/** Called only after a trusted Telegram proof or OIDC ID token is verified. */
export async function exchangeTrustedTelegramUser(
  transaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>,
  fingerprintSecret: Buffer,
  telegramUserId: unknown,
  exchangeHash: Buffer,
  register: boolean,
  ttlSeconds: number,
): Promise<{ token: string; expiresAtUnixSeconds: number } | null> {
  if (
    !validTelegramUserId(telegramUserId) ||
    !Buffer.isBuffer(exchangeHash) ||
    exchangeHash.length !== 32 ||
    typeof register !== "boolean" ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 60 ||
    ttlSeconds > 3600
  ) {
    return null;
  }
  return transaction(async (client) => {
    const fingerprint = await lockTelegramUser(
      client,
      fingerprintSecret,
      telegramUserId,
    );
    return issueGlobalTelegramSession(
      client,
      fingerprint,
      exchangeHash,
      register,
      ttlSeconds,
    );
  });
}

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
  return exchangeMiniAppProof(
    transaction,
    verifier,
    fingerprintSecret,
    rawInitData,
    register,
    (client, fingerprint, exchangeHash) =>
      issueGlobalTelegramSession(
        client,
        fingerprint,
        exchangeHash,
        register,
        ttlSeconds,
      ),
  );
}

async function exchangeMiniAppProof<T>(
  transaction: <R>(work: (client: PoolClient) => Promise<R>) => Promise<R>,
  verifier: TelegramMiniAppProofVerifier,
  fingerprintSecret: Buffer,
  rawInitData: unknown,
  register: boolean,
  issue: (
    client: PoolClient,
    fingerprint: Buffer,
    exchangeHash: Buffer,
  ) => Promise<T | null>,
): Promise<T | null> {
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
    const legacyProof = await client.query(
      "SELECT 1 FROM cookie_identity.opaque_sessions WHERE telegram_exchange_sha256=$1 LIMIT 1",
      [exchangeHash],
    );
    if (legacyProof.rowCount) return null;
    return issue(client, fingerprint, exchangeHash);
  });
}

/**
 * Internal synthetic continuation only; not exported from the package index.
 * The continuation is part of the same acknowledged transaction as proof
 * consumption. It must throw on failure, never publish credentials early.
 */
export async function continueSyntheticTelegramLogin<T>(
  transaction: <R>(work: (client: PoolClient) => Promise<R>) => Promise<R>,
  verifier: TelegramMiniAppProofVerifier,
  fingerprintSecret: Buffer,
  rawInitData: unknown,
  issue: (
    client: PoolClient,
    identityId: string,
    fingerprint: Buffer,
  ) => Promise<T>,
): Promise<T | null> {
  return exchangeMiniAppProof(
    transaction,
    verifier,
    fingerprintSecret,
    rawInitData,
    false,
    async (client, fingerprint, exchangeHash) => {
      const accepted = await consumeGlobalTelegramProof(
        client,
        fingerprint,
        exchangeHash,
        false,
      );
      if (!accepted) return null;
      const result = await issue(client, accepted.identityId, fingerprint);
      await appendAuthIdentityAudit(
        client,
        "telegram_login",
        accepted.identityId,
      );
      return result;
    },
  );
}

/** Attach a Telegram proof to the already-authenticated pre-organization Identity. */
async function linkGlobalTelegramIdentityInTransaction(
  client: PoolClient,
  identityId: string,
  fingerprint: Buffer,
  exchangeHash: Buffer,
): Promise<boolean> {
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
  if (linkedFingerprint && !linkedFingerprint.equals(fingerprint)) return false;

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
  if (consumed.rowCount !== 1) return false;
  await appendAuthIdentityAudit(client, "telegram_provider_linked", identityId);
  return true;
}

/** Link a verified OIDC subject to an already-authenticated Identity. */
export async function linkTrustedTelegramUser(
  transaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>,
  sessionProviders: readonly IdentitySessions[],
  fingerprintSecret: Buffer,
  telegramUserId: unknown,
  exchangeHash: Buffer,
  bearerToken: unknown,
): Promise<boolean> {
  if (
    sessionProviders.length === 0 ||
    !validTelegramUserId(telegramUserId) ||
    !Buffer.isBuffer(exchangeHash) ||
    exchangeHash.length !== 32
  ) {
    return false;
  }
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
      telegramUserId,
    );
    return linkGlobalTelegramIdentityInTransaction(
      client,
      identityId,
      fingerprint,
      exchangeHash,
    );
  });
}

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

    return linkGlobalTelegramIdentityInTransaction(
      client,
      identityId,
      fingerprint,
      exchangeHash,
    );
  });
}
