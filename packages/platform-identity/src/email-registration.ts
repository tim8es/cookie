import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";

import { appendAuthIdentityAudit } from "./auth-security-audit.js";
import { hashPassword } from "./password-crypto.js";
import type { PasswordWorkGate } from "./password-work-gate.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

interface FingerprintRow extends QueryResultRow {
  email_hmac_sha256: Buffer;
}

/**
 * Deliberately conservative ASCII address policy for the initial provider.
 * Preserve the local part exactly; never fold case, dots, or plus tags.
 * Only DNS domain case is normalized. No internationalized local parts yet.
 */
export function canonicalRegistrationEmail(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 254) return null;
  const parts = value.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || !domain || local.length > 64) return null;
  if (
    /[^a-zA-Z0-9.!#$%&'*+/=?^_\x60{|}~-]/.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..")
  ) {
    return null;
  }
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        /[^a-zA-Z0-9-]/.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    return null;
  }
  return local + "@" + domain.toLowerCase();
}

export function emailFingerprint(secret: Buffer, address: string): Buffer {
  if (!Buffer.isBuffer(secret) || secret.length < 32) {
    throw new Error("Invalid email fingerprint secret");
  }
  return createHmac("sha256", secret)
    .update("cookie-email-address-v1\0", "utf8")
    .update(address, "utf8")
    .digest();
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Internal mail-delivery capability only. The raw token must never be returned
 * in an HTTP registration response or logged. Rate limiting, delivery,
 * retention, stable secret provisioning and rotation are required before use.
 * Issuance does not look up existing accounts or attach credentials.
 */
export async function issueEmailRegistrationChallenge(
  transaction: Transaction,
  fingerprintSecret: Buffer,
  input: unknown,
  ttlSeconds: number,
): Promise<{ address: string; token: string } | null> {
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 60 ||
    ttlSeconds > 3600
  ) {
    throw new Error("Invalid email registration lifetime");
  }
  const address = canonicalRegistrationEmail(input);
  if (!address) return null;
  const fingerprint = emailFingerprint(fingerprintSecret, address);
  const token = "er_" + randomBytes(32).toString("base64url");
  return transaction(async (client) => {
    await client.query(
      "INSERT INTO cookie_identity.email_registration_challenges(token_sha256,email_hmac_sha256,created_at,expires_at) VALUES ($1,$2,statement_timestamp(),statement_timestamp()+$3::integer*interval '1 second')",
      [tokenDigest(token), fingerprint, ttlSeconds],
    );
    return { address, token };
  });
}

/**
 * Choose the password only AFTER the recipient obtains the email challenge.
 * A successful exchange creates a global Identity, not a tenant membership,
 * customer, authorization grant or session. No existing account is linked.
 * Callers must enforce password policy, rate limits and bounded KDF work.
 */
export async function completeEmailRegistration(
  transaction: Transaction,
  passwordWork: PasswordWorkGate,
  token: unknown,
  password: unknown,
): Promise<string | null> {
  if (
    typeof token !== "string" ||
    token.length !== 46 ||
    !/^er_[A-Za-z0-9_-]{43}$/.test(token)
  ) {
    return null;
  }
  const digest = tokenDigest(token);
  // Only a plausible live challenge reaches the expensive KDF. This read is
  // not authorization: final consumption and expiry are rechecked atomically.
  const pending = await transaction(async (client) => {
    const result = await client.query(
      "SELECT 1 FROM cookie_identity.email_registration_challenges WHERE token_sha256=$1 AND target_identity_id IS NULL AND expires_at > clock_timestamp()",
      [digest],
    );
    return result.rowCount === 1;
  });
  if (!pending) return null;
  const passwordHash = await passwordWork.run(() => hashPassword(password));

  return transaction(async (client) => {
    const consumed = await client.query<FingerprintRow>(
      "DELETE FROM cookie_identity.email_registration_challenges WHERE token_sha256=$1 AND target_identity_id IS NULL AND expires_at > clock_timestamp() RETURNING email_hmac_sha256",
      [digest],
    );
    const fingerprint = consumed.rows[0]?.email_hmac_sha256;
    if (!fingerprint) return null;

    // Serialize competing challenges for the same canonical address. The
    // unique constraint remains the backstop against future writer mistakes.
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      fingerprint.readBigInt64BE(0).toString(),
    ]);
    const existing = await client.query(
      "SELECT 1 FROM cookie_identity.email_credentials WHERE email_hmac_sha256=$1",
      [fingerprint],
    );
    if (existing.rowCount) return null;

    const identityId = randomUUID();
    await client.query(
      "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid)",
      [identityId],
    );
    await client.query(
      "INSERT INTO cookie_identity.email_credentials(email_hmac_sha256,identity_id,password_hash) VALUES ($1,$2::uuid,$3)",
      [fingerprint, identityId, passwordHash],
    );
    await appendAuthIdentityAudit(client, "email_registered", identityId);
    return identityId;
  });
}
