import type { Pool, PoolClient } from "pg";

import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import {
  completeEmailPasswordRecovery,
  completeEmailRegistration,
  completeEmailCredentialLink,
  createAltareEmailApiTransport,
  createAuthMailQueue,
  createAuthMailWorker,
  createSendmailAuthTransport,
  IdentitySessions,
  loginEmailPassword,
  PasswordWorkGate,
  purgeExpiredEmailRegistrationChallenges,
  type AuthMailLimits,
  type AuthMailLinkConfig,
  type AuthMailTransport,
  type EmailLoginLimits,
} from "../../../packages/platform-identity/src/index.js";
import type { EmailIdentityAuthDependencies } from "./email-identity-auth-http.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

function enabled(env: NodeJS.ProcessEnv): boolean {
  const mode = env.COOKIE_EMAIL_AUTH_MODE;
  if (mode === undefined) return false;
  if (mode !== "enabled") throw new Error("Invalid COOKIE_EMAIL_AUTH_MODE");
  return true;
}

function secret(env: NodeJS.ProcessEnv, name: string): Buffer {
  const value = env[name] ?? "";
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${name} must be 32-byte hex`);
  }
  return Buffer.from(value, "hex");
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}`);
  }
  return parsed;
}

function createMailTransport(
  env: NodeJS.ProcessEnv,
  fromAddress: string,
  timeoutMs: number,
): AuthMailTransport {
  const mode = env.COOKIE_AUTH_MAIL_TRANSPORT ?? "sendmail";
  if (mode === "sendmail") {
    return createSendmailAuthTransport({
      executable: env.COOKIE_AUTH_MAIL_SENDMAIL_PATH ?? "",
      fromAddress,
      timeoutMs,
    });
  }
  if (mode === "altare-api") {
    return createAltareEmailApiTransport({
      apiToken: env.ALTARE_EMAIL_TOKEN ?? "",
      fromAddress,
      timeoutMs,
    });
  }
  throw new Error("Invalid COOKIE_AUTH_MAIL_TRANSPORT");
}

interface WorkerDependencies {
  readonly runOnce: () => Promise<unknown>;
  readonly maintain: () => Promise<void>;
}

/** One serial worker loop per API process; PostgreSQL leases coordinate replicas. */
export function startAuthMailWorker(
  worker: WorkerDependencies,
  onFailure: () => void,
  pollMilliseconds = 2000,
): () => Promise<void> {
  if (!Number.isSafeInteger(pollMilliseconds) || pollMilliseconds < 250) {
    throw new Error("Invalid authentication mail polling interval");
  }
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active = Promise.resolve();
  let maintenanceDue = Date.now();

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      active = (async () => {
        try {
          if (Date.now() >= maintenanceDue) {
            await worker.maintain();
            maintenanceDue = Date.now() + 60_000;
          }
          await worker.runOnce();
        } catch {
          onFailure();
        }
      })();
      void active.finally(schedule);
    }, pollMilliseconds);
    timer.unref();
  };
  schedule();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await active;
  };
}

export interface LiveEmailIdentityAuth {
  readonly sessions: IdentitySessions;
  readonly routes: EmailIdentityAuthDependencies;
  readonly worker: WorkerDependencies;
}

/** Compose email AuthN only when explicitly enabled and fully configured. */
export function createLiveEmailIdentityAuth(
  env: NodeJS.ProcessEnv,
  pool: Pool,
): LiveEmailIdentityAuth | null {
  if (!enabled(env)) return null;

  const fingerprintSecret = secret(env, "COOKIE_AUTH_EMAIL_FINGERPRINT_SECRET");
  const admissionSecret = secret(env, "COOKIE_AUTH_MAIL_ADMISSION_SECRET");
  const encryptionKey = secret(env, "COOKIE_AUTH_MAIL_ENCRYPTION_KEY");
  const fromAddress = env.COOKIE_AUTH_MAIL_FROM ?? "";
  const publicOrigin = env.COOKIE_PUBLIC_ORIGIN ?? "";
  const transaction: Transaction = (work) => runSqlTransaction(pool, work);
  const loginLimits: EmailLoginLimits = {
    windowSeconds: integer(
      env,
      "COOKIE_AUTH_LOGIN_WINDOW_SECONDS",
      900,
      60,
      3600,
    ),
    accountAttempts: integer(
      env,
      "COOKIE_AUTH_LOGIN_ACCOUNT_ATTEMPTS",
      5,
      1,
      1000,
    ),
    sourceAttempts: integer(
      env,
      "COOKIE_AUTH_LOGIN_SOURCE_ATTEMPTS",
      30,
      1,
      10000,
    ),
  };
  const mailLimits: AuthMailLimits = {
    ...loginLimits,
    globalAttempts: integer(
      env,
      "COOKIE_AUTH_MAIL_GLOBAL_ATTEMPTS",
      1000,
      1,
      100000,
    ),
  };
  const links: AuthMailLinkConfig = {
    publicOrigin,
    registrationPath: "/register",
    recoveryPath: "/recover",
    emailLinkPath: "/link-email",
  };
  const transport = createMailTransport(
    env,
    fromAddress,
    integer(env, "COOKIE_AUTH_MAIL_TIMEOUT_MS", 5000, 1000, 30000),
  );
  const queue = createAuthMailQueue({
    transaction,
    fingerprintSecret,
    admissionSecret,
    encryptionKey,
    limits: mailLimits,
    queueTtlSeconds: 3600,
    leaseSeconds: 30,
    dispatchSeconds: 60,
  });
  const sessions = new IdentitySessions(
    pool,
    "cookie-email",
    "cookie-web",
    900,
  );
  const passwordWork = new PasswordWorkGate(
    integer(env, "COOKIE_AUTH_PASSWORD_WORK_CONCURRENCY", 1, 1, 2),
  );
  const registrationTtlSeconds = 900;
  const recoveryTtlSeconds = 900;
  const mailWorker = createAuthMailWorker({
    queue,
    transaction,
    fingerprintSecret,
    links,
    transport,
    registrationTtlSeconds,
    recoveryTtlSeconds,
  });

  return {
    sessions,
    routes: {
      sourceFingerprintSecret: admissionSecret,
      enqueueMail: (purpose, email, source) =>
        queue.enqueue(purpose, email, source),
      completeRegistration: (token, password) =>
        completeEmailRegistration(transaction, passwordWork, token, password),
      login: (email, password, source) =>
        loginEmailPassword(
          transaction,
          passwordWork,
          fingerprintSecret,
          email,
          password,
          sessions,
          loginLimits,
          source,
        ),
      completePasswordRecovery: (token, password) =>
        completeEmailPasswordRecovery(
          transaction,
          passwordWork,
          token,
          password,
        ),
      enqueueEmailLink: (identityId, email, source) =>
        queue.enqueue("email-link", email, source, identityId),
      completeEmailLink: (token, password, identityToken, providers) =>
        completeEmailCredentialLink(
          transaction,
          passwordWork,
          fingerprintSecret,
          providers,
          identityToken,
          token,
          password,
        ),
    },
    worker: {
      runOnce: () => mailWorker.runOnce(),
      maintain: async () => {
        await queue.sweep(100);
        await queue.purge(100, 86_400);
        await purgeExpiredEmailRegistrationChallenges(transaction, 100);
      },
    },
  };
}
