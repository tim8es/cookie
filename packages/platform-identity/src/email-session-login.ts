import type { PoolClient } from "pg";

import { appendAuthIdentityAudit } from "./auth-security-audit.js";
import { withVerifiedEmailPassword } from "./email-login.js";
import {
  reserveEmailLoginAttempt,
  type EmailLoginLimits,
} from "./email-login-throttle.js";
import {
  canonicalRegistrationEmail,
  emailFingerprint,
} from "./email-registration.js";
import type { IdentitySessions } from "./identity-sessions.js";
import type { PasswordWorkGate } from "./password-work-gate.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

export type EmailLoginResult =
  | { status: "denied" | "throttled" }
  | { status: "authenticated"; token: string; expiresAtUnixSeconds: number };

/** Internal only; the source fingerprint is computed by trusted ingress. */
export async function loginEmailPassword(
  transaction: Transaction,
  passwordWork: PasswordWorkGate,
  fingerprintSecret: Buffer,
  email: unknown,
  password: unknown,
  sessions: IdentitySessions,
  limits: EmailLoginLimits,
  sourceFingerprint: Buffer,
): Promise<EmailLoginResult> {
  const address = canonicalRegistrationEmail(email);
  const account = address ? emailFingerprint(fingerprintSecret, address) : null;
  const admitted = await reserveEmailLoginAttempt(
    transaction,
    limits,
    sourceFingerprint,
    account,
  );
  if (!admitted) return { status: "throttled" };
  if (!address) return { status: "denied" };

  const session = await withVerifiedEmailPassword(
    transaction,
    passwordWork,
    fingerprintSecret,
    address,
    password,
    async (client, identityId) => {
      const issued = await sessions.issueForVerifiedIdentityInTransaction(
        client,
        identityId,
      );
      await appendAuthIdentityAudit(client, "email_login", identityId);
      return issued;
    },
  );
  if (!session) return { status: "denied" };
  return { status: "authenticated", ...session };
}
