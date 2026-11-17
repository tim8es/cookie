import type { PoolClient, QueryResultRow } from "pg";

import {
  canonicalRegistrationEmail,
  emailFingerprint,
} from "./email-registration.js";
import { verifyPassword } from "./password-crypto.js";
import type { PasswordWorkGate } from "./password-work-gate.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

interface CredentialRow extends QueryResultRow {
  identity_id: string;
  password_hash: string;
  credential_version: string;
}

// Valid encoding at the same KDF cost; never grants an identity.
const DUMMY_HASH = ["scrypt-v1", "0".repeat(32), "0".repeat(64)].join("$");

/**
 * Internal authentication continuation. Execute only trusted, transactional
 * database work in onVerified, including any future session issuance.
 * No user-provided actor, tenant or permissions are accepted here.
 * External rate limits and a shared PasswordWorkGate are mandatory before
 * exposing an endpoint. Operational errors must not become successful login.
 */
export async function withVerifiedEmailPassword<T>(
  transaction: Transaction,
  passwordWork: PasswordWorkGate,
  fingerprintSecret: Buffer,
  email: unknown,
  password: unknown,
  onVerified: (client: PoolClient, identityId: string) => Promise<T>,
): Promise<T | null> {
  const address = canonicalRegistrationEmail(email);
  if (!address) return null;
  const fingerprint = emailFingerprint(fingerprintSecret, address);

  const credential = await transaction(async (client) => {
    const result = await client.query<CredentialRow>(
      "SELECT identity_id::text,password_hash,credential_version::text FROM cookie_identity.email_credentials WHERE email_hmac_sha256=$1",
      [fingerprint],
    );
    return result.rows[0];
  });

  // Perform the same KDF for a syntactically valid unknown account.
  // Do not hold a database connection or row lock during the KDF.
  const matches = await passwordWork.run(() =>
    verifyPassword(password, credential?.password_hash ?? DUMMY_HASH),
  );
  if (!credential || !matches) return null;

  return transaction(async (client) => {
    // Re-read and lock after verification. Credential removal or password
    // rotation during the KDF must not authorize session issuance.
    const current = await client.query<CredentialRow>(
      "SELECT identity_id::text,password_hash,credential_version::text FROM cookie_identity.email_credentials WHERE email_hmac_sha256=$1 FOR SHARE",
      [fingerprint],
    );
    const row = current.rows[0];
    if (
      !row ||
      row.identity_id !== credential.identity_id ||
      row.credential_version !== credential.credential_version ||
      row.password_hash !== credential.password_hash
    ) {
      return null;
    }
    return onVerified(client, row.identity_id);
  });
}
