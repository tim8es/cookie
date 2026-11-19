import type { PoolClient, QueryResultRow } from "pg";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface EmailLoginLimits {
  readonly windowSeconds: number;
  readonly accountAttempts: number;
  readonly sourceAttempts: number;
}

interface WindowRow extends QueryResultRow {
  window_start: string;
}

interface AttemptRow extends QueryResultRow {
  attempts: number;
}

function validLimit(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= max;
}

function validFingerprint(value: Buffer): boolean {
  return Buffer.isBuffer(value) && value.length === 32;
}

async function increment(
  client: PoolClient,
  scope: "source" | "account",
  fingerprint: Buffer,
  seconds: number,
  start: string,
): Promise<number> {
  const result = await client.query<AttemptRow>(
    `INSERT INTO cookie_identity.email_login_attempts
       (scope, subject_hmac_sha256, window_seconds, window_start_epoch, attempts)
     VALUES ($1,$2,$3,$4::bigint,1)
     ON CONFLICT (scope, subject_hmac_sha256, window_seconds, window_start_epoch)
     DO UPDATE SET attempts = LEAST(email_login_attempts.attempts + 1, 1000001)
     RETURNING attempts`,
    [scope, fingerprint, seconds, start],
  );
  const attempts = result.rows[0]?.attempts;
  if (result.rowCount !== 1 || !validLimit(attempts ?? 0, 1000001)) {
    throw new Error("Login attempt accounting failed");
  }
  return attempts!;
}

/**
 * Atomically reserve an attempt before credential lookup or expensive KDF.
 * All replicas must share the database, fingerprint keys and policy.
 * Source is a server-derived fingerprint, never an HTTP-supplied identity.
 * A blocked source cannot consume another account's budget. A rejected
 * account attempt still consumes the admitted source's budget.
 * Count all admitted attempts (including success), with a fixed DB-clock
 * window; two adjacent windows can admit a burst. Not a public endpoint.
 */
export async function reserveEmailLoginAttempt(
  transaction: Transaction,
  limits: EmailLoginLimits,
  sourceFingerprint: Buffer,
  accountFingerprint: Buffer | null,
  globalBudget?: { readonly fingerprint: Buffer; readonly attempts: number },
): Promise<boolean> {
  const { windowSeconds, accountAttempts, sourceAttempts } = limits;
  if (
    !validLimit(windowSeconds, 3600) ||
    !validLimit(accountAttempts, 1000000) ||
    !validLimit(sourceAttempts, 1000000) ||
    !validFingerprint(sourceFingerprint) ||
    (accountFingerprint !== null && !validFingerprint(accountFingerprint)) ||
    (globalBudget !== undefined &&
      (!validFingerprint(globalBudget.fingerprint) ||
        globalBudget.fingerprint.equals(sourceFingerprint) ||
        !validLimit(globalBudget.attempts, 1000000)))
  ) {
    throw new Error("Invalid login throttle configuration or fingerprint");
  }

  return transaction(async (client) => {
    const result = await client.query<WindowRow>(
      `SELECT (floor(extract(epoch FROM clock_timestamp()) / $1::integer)::bigint
        * $1::integer)::text AS window_start`,
      [windowSeconds],
    );
    const start = result.rows[0]?.window_start;
    if (!start || !/^[0-9]+$/.test(start)) {
      throw new Error("Login throttle clock unavailable");
    }
    // Optional mail-global budget precedes source and account. All budgets
    // use the same database-clock window and the same transaction.
    if (globalBudget) {
      const global = await increment(
        client,
        "source",
        globalBudget.fingerprint,
        windowSeconds,
        start,
      );
      if (global > globalBudget.attempts) return false;
    }
    // Every transaction acquires source before account, avoiding lock cycles.
    const source = await increment(
      client,
      "source",
      sourceFingerprint,
      windowSeconds,
      start,
    );
    if (source > sourceAttempts) return false;
    if (accountFingerprint !== null) {
      const account = await increment(
        client,
        "account",
        accountFingerprint,
        windowSeconds,
        start,
      );
      if (account > accountAttempts) return false;
    }

    // A request that waited on locks across a window boundary must not
    // authenticate using an expired budget, even if cleanup removed its row.
    const live = await client.query<{ active: boolean }>(
      `SELECT $1::bigint <= floor(extract(epoch FROM clock_timestamp()))::bigint
        AND floor(extract(epoch FROM clock_timestamp()))::bigint <
          $1::bigint + $2::integer AS active`,
      [start, windowSeconds],
    );
    return live.rows[0]?.active === true;
  });
}

/** Bounded maintenance; schedule independently of the request path. */
export async function purgeExpiredEmailLoginAttempts(
  transaction: Transaction,
  batchSize: number,
): Promise<number> {
  if (!validLimit(batchSize, 10000)) {
    throw new Error("Invalid login throttle cleanup batch");
  }
  return transaction(async (client) => {
    const result = await client.query(
      `WITH expired AS (
        SELECT ctid FROM cookie_identity.email_login_attempts
        WHERE window_start_epoch + window_seconds <=
          floor(extract(epoch FROM statement_timestamp()))::bigint
        ORDER BY window_start_epoch + window_seconds
        LIMIT $1 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM cookie_identity.email_login_attempts AS attempts
      USING expired WHERE attempts.ctid = expired.ctid`,
      [batchSize],
    );
    if (result.rowCount === null) {
      throw new Error("Login throttle cleanup failed");
    }
    return result.rowCount;
  });
}
