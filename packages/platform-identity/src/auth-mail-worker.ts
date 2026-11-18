import type { PoolClient } from "pg";

import {
  createAuthMailDelivery,
  type AuthMailLinkConfig,
  type AuthMailTransport,
} from "./auth-mail-delivery.js";
import type {
  AuthMailTerminal,
  createAuthMailQueue,
} from "./auth-mail-queue.js";
import { issueEmailPasswordRecovery } from "./email-password-recovery.js";
import { issueEmailCredentialLinkChallenge } from "./email-credential-link.js";
import { issueEmailRegistrationChallenge } from "./email-registration.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

type Queue = ReturnType<typeof createAuthMailQueue>;

/**
 * Trusted one-job worker. No public API and no automatic resend after
 * dispatch start, since sendmail has no idempotent submission guarantee.
 */
export function createAuthMailWorker(config: {
  queue: Pick<Queue, "claim" | "start" | "finish">;
  transaction: Transaction;
  fingerprintSecret: Buffer;
  links: AuthMailLinkConfig;
  transport: AuthMailTransport;
  registrationTtlSeconds: number;
  recoveryTtlSeconds: number;
}) {
  if (
    !Buffer.isBuffer(config.fingerprintSecret) ||
    config.fingerprintSecret.length < 32
  ) {
    throw new Error("Invalid auth mail worker fingerprint secret");
  }
  const { queue, transaction, registrationTtlSeconds, recoveryTtlSeconds } =
    config;
  for (const ttl of [registrationTtlSeconds, recoveryTtlSeconds]) {
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 3600) {
      throw new Error("Invalid auth mail worker proof lifetime");
    }
  }
  const secret = Buffer.from(config.fingerprintSecret);
  const delivery = createAuthMailDelivery(config.links, config.transport);

  return {
    async runOnce(): Promise<AuthMailTerminal | "idle" | "stale"> {
      const lease = await queue.claim();
      if (!lease) return "idle";
      let status: AuthMailTerminal = "unknown";
      try {
        const job = await queue.start(lease);
        if (!job) return "stale";
        const challenge =
          job.purpose === "registration"
            ? await issueEmailRegistrationChallenge(
                transaction,
                secret,
                job.address,
                registrationTtlSeconds,
              )
            : job.purpose === "password-recovery"
              ? await issueEmailPasswordRecovery(
                  transaction,
                  secret,
                  job.address,
                  recoveryTtlSeconds,
                )
              : job.identityId
                ? await issueEmailCredentialLinkChallenge(
                    transaction,
                    secret,
                    job.address,
                    job.identityId,
                    registrationTtlSeconds,
                  )
                : null;
        if (challenge) {
          await delivery.send(job.purpose, challenge);
          status = "submitted";
        } else {
          status = "skipped";
        }
      } catch {
        // Never persist transport or crypto exception details. If submission
        // may have happened, report an unknown outcome, not "not delivered".
        status = "unknown";
      }
      return (await queue.finish(lease, status)) ? status : "stale";
    },
  };
}
