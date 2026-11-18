import { createHash, randomBytes } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";

import { appendAuthIdentityAudit } from "./auth-security-audit.js";
import {
  canonicalRegistrationEmail,
  emailFingerprint,
} from "./email-registration.js";
import type { IdentitySessions } from "./identity-sessions.js";
import { hashPassword } from "./password-crypto.js";
import type { PasswordWorkGate } from "./password-work-gate.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

interface LinkChallengeRow extends QueryResultRow {
  email_hmac_sha256: Buffer;
  target_identity_id: string;
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Issue a one-time email proof bound to an already authenticated Identity. */
export async function issueEmailCredentialLinkChallenge(
  transaction: Transaction,
  fingerprintSecret: Buffer,
  email: unknown,
  targetIdentityId: string,
  ttlSeconds: number,
): Promise<{ address: string; token: string } | null> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      targetIdentityId,
    ) ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 60 ||
    ttlSeconds > 3600
  ) {
    throw new Error("Invalid email credential link configuration");
  }
  const address = canonicalRegistrationEmail(email);
  if (!address) return null;
  const fingerprint = emailFingerprint(fingerprintSecret, address);
  const token = "el_" + randomBytes(32).toString("base64url");
  return transaction(async (client) => {
    const existing = await client.query(
      `SELECT 1 FROM cookie_identity.email_credentials
       WHERE email_hmac_sha256=$1 OR identity_id=$2::uuid`,
      [fingerprint, targetIdentityId],
    );
    if (existing.rowCount) return null;
    const identity = await client.query(
      "SELECT id FROM cookie_identity.identities WHERE id=$1::uuid",
      [targetIdentityId],
    );
    if (identity.rowCount !== 1) return null;
    await client.query(
      `INSERT INTO cookie_identity.email_registration_challenges
         (token_sha256,email_hmac_sha256,target_identity_id,created_at,expires_at)
       VALUES($1,$2,$3::uuid,clock_timestamp(),clock_timestamp()+$4::integer*interval '1 second')`,
      [digest(token), fingerprint, targetIdentityId, ttlSeconds],
    );
    return { address, token };
  });
}

/** Attach email only when the same live Identity session completes the proof. */
export async function completeEmailCredentialLink(
  transaction: Transaction,
  passwordWork: PasswordWorkGate,
  fingerprintSecret: Buffer,
  sessionProviders: readonly IdentitySessions[],
  bearerToken: unknown,
  token: unknown,
  password: unknown,
): Promise<boolean> {
  if (
    !sessionProviders.length ||
    typeof token !== "string" ||
    token.length !== 46 ||
    !/^el_[A-Za-z0-9_-]{43}$/.test(token)
  ) {
    return false;
  }
  const tokenHash = digest(token);
  const pending = await transaction(async (client) => {
    const result = await client.query<LinkChallengeRow>(
      `SELECT email_hmac_sha256,target_identity_id::text
       FROM cookie_identity.email_registration_challenges
       WHERE token_sha256=$1 AND target_identity_id IS NOT NULL
         AND expires_at>clock_timestamp()`,
      [tokenHash],
    );
    return result.rows[0];
  });
  if (!pending) return false;
  const authenticatedIdentity = await transaction(async (client) => {
    for (const provider of sessionProviders) {
      const identityId = await provider.resolveWithinTransaction(
        client,
        bearerToken,
      );
      if (identityId) return identityId;
    }
    return null;
  });
  if (authenticatedIdentity !== pending.target_identity_id) return false;
  const passwordHash = await passwordWork.run(() => hashPassword(password));

  return transaction(async (client) => {
    let identityId: string | null = null;
    for (const provider of sessionProviders) {
      identityId = await provider.resolveWithinTransaction(client, bearerToken);
      if (identityId) break;
    }
    if (!identityId || identityId !== pending.target_identity_id) return false;

    const identity = await client.query(
      "SELECT id FROM cookie_identity.identities WHERE id=$1::uuid FOR UPDATE",
      [identityId],
    );
    if (identity.rowCount !== 1) return false;
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      pending.email_hmac_sha256.readBigInt64BE(0).toString(),
    ]);

    const consumed = await client.query(
      `DELETE FROM cookie_identity.email_registration_challenges
       WHERE token_sha256=$1 AND email_hmac_sha256=$2
         AND target_identity_id=$3::uuid AND expires_at>clock_timestamp()
       RETURNING email_hmac_sha256`,
      [tokenHash, pending.email_hmac_sha256, identityId],
    );
    if (consumed.rowCount !== 1) return false;

    const existing = await client.query(
      `SELECT 1 FROM cookie_identity.email_credentials
       WHERE email_hmac_sha256=$1 OR identity_id=$2::uuid`,
      [pending.email_hmac_sha256, identityId],
    );
    if (existing.rowCount) return false;

    await client.query(
      `INSERT INTO cookie_identity.email_credentials
         (email_hmac_sha256,identity_id,password_hash)
       VALUES($1,$2::uuid,$3)`,
      [pending.email_hmac_sha256, identityId, passwordHash],
    );
    await appendAuthIdentityAudit(client, "email_provider_linked", identityId);
    return true;
  });
}

/** Bounded cleanup for expired registration and email-link challenges. */
export async function purgeExpiredEmailRegistrationChallenges(
  transaction: Transaction,
  batchSize: number,
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new Error("Invalid email registration cleanup batch");
  }
  return transaction(async (client) => {
    const result = await client.query(
      `WITH expired AS (
        SELECT token_sha256 FROM cookie_identity.email_registration_challenges
        WHERE expires_at<=clock_timestamp()
        ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM cookie_identity.email_registration_challenges AS challenge
      USING expired WHERE challenge.token_sha256=expired.token_sha256`,
      [batchSize],
    );
    if (result.rowCount === null)
      throw new Error("Email registration cleanup failed");
    return result.rowCount;
  });
}
