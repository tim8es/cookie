import { createHmac } from "node:crypto";

import type { PoolClient } from "pg";

import {
  reserveEmailLoginAttempt,
  type EmailLoginLimits,
} from "./email-login-throttle.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface AuthMailLimits extends EmailLoginLimits {
  readonly globalAttempts: number;
}

function derive(secret: Buffer, scope: string, subject: Buffer): Buffer {
  return createHmac("sha256", secret)
    .update("cookie-auth-mail-admission-v1\0", "utf8")
    .update(scope, "utf8")
    .update("\0", "utf8")
    .update(subject)
    .digest();
}

/**
 * Reserve shared mail-request capacity before checking account existence,
 * generating a challenge, or invoking a transport. Both purposes share the
 * same budgets. HMAC namespaces isolate these counters from login counters.
 *
 * The global budget is acquired first, then source, then account. All are
 * committed together even when denied; transport failures are not refunded.
 * This intentionally counts attempts rather than successful deliveries.
 */
export function createAuthMailAdmission(config: {
  transaction: Transaction;
  namespaceSecret: Buffer;
  limits: AuthMailLimits;
}): {
  reserve(source: Buffer, recipient: Buffer | null): Promise<boolean>;
} {
  const { transaction, limits } = config;
  const { windowSeconds, accountAttempts, sourceAttempts, globalAttempts } =
    limits;
  if (
    !Buffer.isBuffer(config.namespaceSecret) ||
    config.namespaceSecret.length < 32 ||
    !Number.isSafeInteger(windowSeconds) ||
    windowSeconds < 1 ||
    windowSeconds > 3600 ||
    [accountAttempts, sourceAttempts, globalAttempts].some(
      (n) => !Number.isSafeInteger(n) || n < 1 || n > 1000000,
    )
  ) {
    throw new Error("Invalid authentication mail admission configuration");
  }
  const secret = Buffer.from(config.namespaceSecret);
  const global = derive(secret, "global", Buffer.alloc(0));
  const base = { windowSeconds, accountAttempts, sourceAttempts };

  return {
    async reserve(source, recipient) {
      if (
        !Buffer.isBuffer(source) ||
        source.length !== 32 ||
        (recipient !== null &&
          (!Buffer.isBuffer(recipient) || recipient.length !== 32))
      ) {
        throw new Error("Invalid authentication mail subject fingerprint");
      }
      const namespacedSource = derive(secret, "source", source);
      const namespacedRecipient = recipient
        ? derive(secret, "recipient", recipient)
        : null;

      return reserveEmailLoginAttempt(
        transaction,
        base,
        namespacedSource,
        namespacedRecipient,
        { fingerprint: global, attempts: globalAttempts },
      );
    },
  };
}
