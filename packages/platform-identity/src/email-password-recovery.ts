import { createHash, randomBytes } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";

import { appendAuthIdentityAudit } from "./auth-security-audit.js";
import {
  canonicalRegistrationEmail,
  emailFingerprint,
} from "./email-registration.js";
import { hashPassword } from "./password-crypto.js";
import type { PasswordWorkGate } from "./password-work-gate.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

interface CredentialRow extends QueryResultRow {
  identity_id: string;
  credential_version: string;
}

interface ChallengeRow extends CredentialRow {
  email_hmac_sha256: Buffer;
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Internal delivery adapter only. Never expose the result, token, or account
 * existence through a public response. Ingress must enforce mail/reset rate
 * limits before this call. The address and token are not persisted as text.
 */
export async function issueEmailPasswordRecovery(
  transaction: Transaction,
  fingerprintSecret: Buffer,
  email: unknown,
  ttlSeconds: number,
): Promise<{ address: string; token: string } | null> {
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 60 ||
    ttlSeconds > 3600
  ) {
    throw new Error("Invalid password recovery lifetime");
  }
  const address = canonicalRegistrationEmail(email);
  if (!address) return null;
  const fingerprint = emailFingerprint(fingerprintSecret, address);
  const token = "ep_" + randomBytes(32).toString("base64url");

  return transaction(async (client) => {
    const result = await client.query<CredentialRow>(
      `SELECT identity_id::text, credential_version::text
       FROM cookie_identity.email_credentials
       WHERE email_hmac_sha256=$1 FOR SHARE`,
      [fingerprint],
    );
    const credential = result.rows[0];
    if (!credential) return null;

    await client.query(
      `INSERT INTO cookie_identity.email_password_recovery_challenges
       (token_sha256,email_hmac_sha256,credential_version,created_at,expires_at)
       VALUES ($1,$2,$3::uuid,statement_timestamp(),
         statement_timestamp()+$4::integer*interval '1 second')`,
      [digest(token), fingerprint, credential.credential_version, ttlSeconds],
    );
    return { address, token };
  });
}

/**
 * A recovery proof changes only an existing email credential. It does not
 * register, link, create a membership, or log the caller in.
 * Password policy and ingress rate limiting belong to the future adapter.
 */
export async function completeEmailPasswordRecovery(
  transaction: Transaction,
  passwordWork: PasswordWorkGate,
  token: unknown,
  password: unknown,
): Promise<boolean> {
  if (
    typeof token !== "string" ||
    token.length !== 46 ||
    !/^ep_[A-Za-z0-9_-]{43}$/.test(token)
  ) {
    return false;
  }
  const tokenHash = digest(token);
  const pending = await transaction(async (client) => {
    const result = await client.query<ChallengeRow>(
      `SELECT r.email_hmac_sha256, r.credential_version::text,
         c.identity_id::text
       FROM cookie_identity.email_password_recovery_challenges r
       JOIN cookie_identity.email_credentials c
         ON c.email_hmac_sha256=r.email_hmac_sha256
         AND c.credential_version=r.credential_version
       WHERE r.token_sha256=$1 AND r.expires_at>clock_timestamp()`,
      [tokenHash],
    );
    return result.rows[0];
  });
  if (!pending) return false;
  const newHash = await passwordWork.run(() => hashPassword(password));

  return transaction(async (client) => {
    // Same credential row as login's FOR SHARE; always lock it before
    // consuming recovery tokens. No KDF is executed under the lock.
    const locked = await client.query<CredentialRow>(
      `SELECT identity_id::text, credential_version::text
       FROM cookie_identity.email_credentials
       WHERE email_hmac_sha256=$1 FOR UPDATE`,
      [pending.email_hmac_sha256],
    );
    const current = locked.rows[0];
    if (
      !current ||
      current.identity_id !== pending.identity_id ||
      current.credential_version !== pending.credential_version
    ) {
      return false;
    }

    const consumed = await client.query(
      `DELETE FROM cookie_identity.email_password_recovery_challenges
       WHERE token_sha256=$1 AND email_hmac_sha256=$2
         AND credential_version=$3::uuid AND expires_at>clock_timestamp()`,
      [tokenHash, pending.email_hmac_sha256, pending.credential_version],
    );
    if (consumed.rowCount !== 1) return false;

    const changed = await client.query(
      `UPDATE cookie_identity.email_credentials SET password_hash=$1
       WHERE email_hmac_sha256=$2 AND credential_version=$3::uuid`,
      [newHash, pending.email_hmac_sha256, pending.credential_version],
    );
    if (changed.rowCount !== 1) {
      throw new Error("Password recovery credential update failed");
    }
    await client.query(
      `DELETE FROM cookie_identity.email_password_recovery_challenges
       WHERE email_hmac_sha256=$1`,
      [pending.email_hmac_sha256],
    );
    // Revoke existing global/pre-organization sessions. Legacy tenant
    // sessions and future cross-provider issuance require explicit review.
    await client.query(
      `UPDATE cookie_identity.identity_sessions SET revoked_at=clock_timestamp()
       WHERE identity_id=$1::uuid AND revoked_at IS NULL`,
      [pending.identity_id],
    );
    await appendAuthIdentityAudit(
      client,
      "password_recovered",
      pending.identity_id,
    );
    return true;
  });
}

/** Bounded maintenance; callers must schedule it outside the request path. */
export async function purgeExpiredEmailRecoveryChallenges(
  transaction: Transaction,
  batchSize: number,
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10000) {
    throw new Error("Invalid recovery cleanup batch");
  }
  return transaction(async (client) => {
    const result = await client.query(
      `WITH expired AS (
        SELECT token_sha256
        FROM cookie_identity.email_password_recovery_challenges
        WHERE expires_at<=statement_timestamp()
        ORDER BY expires_at
        LIMIT $1 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM cookie_identity.email_password_recovery_challenges AS r
      USING expired WHERE r.token_sha256=expired.token_sha256`,
      [batchSize],
    );
    if (result.rowCount === null) {
      throw new Error("Recovery cleanup failed");
    }
    return result.rowCount;
  });
}
