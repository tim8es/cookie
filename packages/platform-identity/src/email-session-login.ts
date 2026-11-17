import type { PoolClient } from "pg";
import { withVerifiedEmailPassword } from "./email-login.js";
import type { IdentitySessions } from "./identity-sessions.js";
import type { PasswordWorkGate } from "./password-work-gate.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

export function loginEmailPassword(
  transaction: Transaction,
  passwordWork: PasswordWorkGate,
  fingerprintSecret: Buffer,
  email: unknown,
  password: unknown,
  sessions: IdentitySessions,
): Promise<{ token: string; expiresAtUnixSeconds: number } | null> {
  return withVerifiedEmailPassword(
    transaction,
    passwordWork,
    fingerprintSecret,
    email,
    password,
    (client, identityId) =>
      sessions.issueForVerifiedIdentityInTransaction(client, identityId),
  );
}
