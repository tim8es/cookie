import type { PoolClient } from "pg";

import {
  createAuthMailAdmission,
  type AuthMailLimits,
} from "./auth-mail-admission.js";
import {
  createAuthMailDelivery,
  type AuthMailLinkConfig,
  type AuthMailPurpose,
  type AuthMailTransport,
} from "./auth-mail-delivery.js";
import { issueEmailPasswordRecovery } from "./email-password-recovery.js";
import {
  canonicalRegistrationEmail,
  emailFingerprint,
  issueEmailRegistrationChallenge,
} from "./email-registration.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

/**
 * Trusted internal delivery worker capability, not a public request handler.
 * Mail admission commits before issuing a proof. The caller may not
 * expose delivery latency, failure, or account-existence signals to clients.
 * No secrets are returned to the worker caller or logged by this module.
 */
export function createEmailChallengeMailer(config: {
  transaction: Transaction;
  fingerprintSecret: Buffer;
  admissionSecret: Buffer;
  limits: AuthMailLimits;
  links: AuthMailLinkConfig;
  transport: AuthMailTransport;
  registrationTtlSeconds: number;
  recoveryTtlSeconds: number;
}): {
  deliver(
    purpose: AuthMailPurpose,
    email: unknown,
    sourceFingerprint: Buffer,
  ): Promise<void>;
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
  const admission = createAuthMailAdmission({
    transaction,
    namespaceSecret: config.admissionSecret,
    limits: config.limits,
  });
  return {
    async deliver(purpose, email, sourceFingerprint) {
      if (purpose !== "registration" && purpose !== "password-recovery") {
        throw new Error("Invalid authentication mail purpose");
      }
      const address = canonicalRegistrationEmail(email);
      const recipient = address ? emailFingerprint(secret, address) : null;
      if (!(await admission.reserve(sourceFingerprint, recipient))) return;
      if (!address) return;
      const challenge =
        purpose === "registration"
          ? await issueEmailRegistrationChallenge(
              transaction,
              secret,
              address,
              registrationTtlSeconds,
            )
          : await issueEmailPasswordRecovery(
              transaction,
              secret,
              address,
              recoveryTtlSeconds,
            );
      if (challenge) await delivery.send(purpose, challenge);
    },
  };
}
