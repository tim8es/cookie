import type { PoolClient } from "pg";

import {
  createAuthMailDelivery,
  type AuthMailLinkConfig,
  type AuthMailPurpose,
  type AuthMailTransport,
} from "./auth-mail-delivery.js";
import { issueEmailPasswordRecovery } from "./email-password-recovery.js";
import { issueEmailRegistrationChallenge } from "./email-registration.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

/**
 * Trusted internal delivery worker capability, not a public request handler.
 * Upstream admission must be committed before invoking it. The caller may not
 * expose delivery latency, failure, or account-existence signals to clients.
 * No secrets are returned to the worker caller or logged by this module.
 */
export function createEmailChallengeMailer(config: {
  transaction: Transaction;
  fingerprintSecret: Buffer;
  links: AuthMailLinkConfig;
  transport: AuthMailTransport;
  registrationTtlSeconds: number;
  recoveryTtlSeconds: number;
}): {
  deliver(purpose: AuthMailPurpose, email: unknown): Promise<void>;
} {
  if (
    !Buffer.isBuffer(config.fingerprintSecret) ||
    config.fingerprintSecret.length < 32
  ) {
    throw new Error("Invalid authentication mail fingerprint secret");
  }
  for (const ttl of [
    config.registrationTtlSeconds,
    config.recoveryTtlSeconds,
  ]) {
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 3600) {
      throw new Error("Invalid authentication mail lifetime");
    }
  }
  const secret = Buffer.from(config.fingerprintSecret);
  const { transaction, registrationTtlSeconds, recoveryTtlSeconds } = config;
  const delivery = createAuthMailDelivery(config.links, config.transport);
  return {
    async deliver(purpose, email) {
      if (purpose !== "registration" && purpose !== "password-recovery") {
        throw new Error("Invalid authentication mail purpose");
      }
      const challenge =
        purpose === "registration"
          ? await issueEmailRegistrationChallenge(
              transaction,
              secret,
              email,
              registrationTtlSeconds,
            )
          : await issueEmailPasswordRecovery(
              transaction,
              secret,
              email,
              recoveryTtlSeconds,
            );
      if (challenge) await delivery.send(purpose, challenge);
    },
  };
}
