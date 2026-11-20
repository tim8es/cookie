import { randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";

import {
  createAuthMailAdmission,
  type AuthMailLimits,
} from "./auth-mail-admission.js";
import type { AuthMailPurpose } from "./auth-mail-delivery.js";
import { createAuthMailEnvelope } from "./auth-mail-envelope.js";
import {
  canonicalRegistrationEmail,
  emailFingerprint,
} from "./email-registration.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface AuthMailLease {
  readonly id: string;
  readonly lease_token: string;
}
type LeaseRow = QueryResultRow & AuthMailLease;
interface StartRow extends QueryResultRow {
  purpose: AuthMailPurpose;
  identity_id: string | null;
  sealed_recipient: Buffer;
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AuthMailTerminal = "submitted" | "skipped" | "unknown";

function bounded(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

export function createAuthMailQueue(config: {
  transaction: Transaction;
  fingerprintSecret: Buffer;
  admissionSecret: Buffer;
  encryptionKey: Buffer;
  limits: AuthMailLimits;
  queueTtlSeconds: number;
  leaseSeconds: number;
  dispatchSeconds: number;
}) {
  const { transaction, queueTtlSeconds, leaseSeconds, dispatchSeconds } =
    config;
  if (
    !Buffer.isBuffer(config.fingerprintSecret) ||
    config.fingerprintSecret.length < 32 ||
    !bounded(queueTtlSeconds, 60, 3600) ||
    !bounded(leaseSeconds, 1, 300) ||
    !bounded(dispatchSeconds, 1, 600)
  ) {
    throw new Error("Invalid auth mail queue configuration");
  }
  const fingerprintSecret = Buffer.from(config.fingerprintSecret);
  const admissionSecret = Buffer.from(config.admissionSecret);
  const limits = { ...config.limits };
  const envelope = createAuthMailEnvelope(config.encryptionKey);
  // Validate configuration at construction, before a request is admitted.
  createAuthMailAdmission({
    transaction,
    namespaceSecret: admissionSecret,
    limits,
  });

  return {
    /** Public adapter may return a generic acknowledgement only after commit. */
    async enqueue(
      purpose: AuthMailPurpose,
      email: unknown,
      sourceFingerprint: Buffer,
      identityId?: string,
    ): Promise<void> {
      if (
        (purpose !== "registration" &&
          purpose !== "password-recovery" &&
          purpose !== "email-link") ||
        (purpose === "email-link" &&
          (typeof identityId !== "string" || !UUID.test(identityId))) ||
        (purpose !== "email-link" && identityId !== undefined)
      ) {
        throw new Error("Invalid auth mail purpose");
      }
      const address = canonicalRegistrationEmail(email);
      const recipient = address
        ? emailFingerprint(fingerprintSecret, address)
        : null;
      await transaction(async (client) => {
        const admission = createAuthMailAdmission({
          transaction: (work) => work(client),
          namespaceSecret: admissionSecret,
          limits,
        });
        if (!(await admission.reserve(sourceFingerprint, recipient))) return;
        if (!address) return;
        const id = randomUUID();
        const sealed = envelope.seal(id, purpose, address);
        await client.query(
          `INSERT INTO cookie_identity.auth_mail_jobs
           (id,purpose,identity_id,sealed_recipient,status,created_at,expires_at)
           VALUES ($1::uuid,$2,$3::uuid,$4,'pending',statement_timestamp(),
             statement_timestamp()+$5::integer*interval '1 second')`,
          [id, purpose, identityId ?? null, sealed, queueTtlSeconds],
        );
      });
    },

    /** Claim is reclaimable until dispatch starts; no bearer or address returned. */
    async claim(): Promise<AuthMailLease | null> {
      return transaction(async (client) => {
        const result = await client.query<LeaseRow>(
          `WITH chosen AS (
             SELECT id FROM cookie_identity.auth_mail_jobs
             WHERE expires_at>clock_timestamp()
               AND (status='pending' OR
                 (status='leased' AND lease_until<=clock_timestamp()))
             ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
           )
           UPDATE cookie_identity.auth_mail_jobs AS job
           SET status='leased',lease_token=gen_random_uuid(),
             lease_until=clock_timestamp()+$1::integer*interval '1 second'
           FROM chosen WHERE job.id=chosen.id
           RETURNING job.id::text,job.lease_token::text`,
          [leaseSeconds],
        );
        return result.rows[0] ?? null;
      });
    },

    /**
     * Commit an irreversible dispatch start before exposing the address to
     * the worker. Never reclaim dispatching work: external submission may
     * already have happened. Clear encrypted address even on worker crash.
     */
    async start(lease: AuthMailLease): Promise<{
      purpose: AuthMailPurpose;
      identityId?: string;
      address: string;
    } | null> {
      const row = await transaction(async (client) => {
        const result = await client.query<StartRow>(
          `WITH chosen AS (
             SELECT id,purpose,identity_id,sealed_recipient
             FROM cookie_identity.auth_mail_jobs
             WHERE id=$1::uuid AND lease_token=$2::uuid AND status='leased'
               AND expires_at>clock_timestamp()
               AND lease_until>clock_timestamp()
             FOR UPDATE
           )
           UPDATE cookie_identity.auth_mail_jobs AS job
           SET status='dispatching',sealed_recipient=NULL,
             lease_until=clock_timestamp()+$3::integer*interval '1 second'
           FROM chosen WHERE job.id=chosen.id
           RETURNING chosen.purpose,chosen.identity_id::text,chosen.sealed_recipient`,
          [lease.id, lease.lease_token, dispatchSeconds],
        );
        return result.rows[0];
      });
      if (!row) return null;
      return {
        purpose: row.purpose,
        ...(row.identity_id ? { identityId: row.identity_id } : {}),
        address: envelope.open(lease.id, row.purpose, row.sealed_recipient),
      };
    },

    /** Fence proof generation or transport submission after a stalled worker. */
    async isDispatchLive(lease: AuthMailLease): Promise<boolean> {
      return transaction(async (client) => {
        const result = await client.query(
          `SELECT 1 FROM cookie_identity.auth_mail_jobs
           WHERE id=$1::uuid AND lease_token=$2::uuid
             AND status='dispatching' AND lease_until>clock_timestamp()`,
          [lease.id, lease.lease_token],
        );
        return result.rowCount === 1;
      });
    },

    async finish(
      lease: AuthMailLease,
      status: AuthMailTerminal,
    ): Promise<boolean> {
      if (!["submitted", "skipped", "unknown"].includes(status)) {
        throw new Error("Invalid auth mail terminal status");
      }
      return transaction(async (client) => {
        const result = await client.query(
          `UPDATE cookie_identity.auth_mail_jobs
           SET status=$3,lease_token=NULL,lease_until=NULL
           WHERE id=$1::uuid AND lease_token=$2::uuid
             AND status='dispatching' AND lease_until>clock_timestamp()`,
          [lease.id, lease.lease_token, status],
        );
        return result.rowCount === 1;
      });
    },

    /** Bounded expiry sweep. A started job is never returned to pending. */
    async sweep(batchSize: number): Promise<number> {
      if (!bounded(batchSize, 1, 1000)) {
        throw new Error("Invalid auth mail sweep batch");
      }
      return transaction(async (client) => {
        const result = await client.query(
          `WITH chosen AS (
             SELECT id FROM cookie_identity.auth_mail_jobs
             WHERE (status IN ('pending','leased') AND expires_at<=clock_timestamp())
                OR (status='dispatching' AND lease_until<=clock_timestamp())
             ORDER BY expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
           )
           UPDATE cookie_identity.auth_mail_jobs AS job
           SET status=CASE WHEN job.status='dispatching' THEN 'unknown'
             ELSE 'expired' END, sealed_recipient=NULL,
             lease_token=NULL,lease_until=NULL
           FROM chosen WHERE job.id=chosen.id`,
          [batchSize],
        );
        if (result.rowCount === null) throw new Error("Auth mail sweep failed");
        return result.rowCount;
      });
    },

    async purge(batchSize: number, retentionSeconds: number): Promise<number> {
      if (
        !bounded(batchSize, 1, 1000) ||
        !bounded(retentionSeconds, 60, 2592000)
      ) {
        throw new Error("Invalid auth mail retention configuration");
      }
      return transaction(async (client) => {
        const result = await client.query(
          `WITH chosen AS (
             SELECT id FROM cookie_identity.auth_mail_jobs
             WHERE status IN ('submitted','skipped','unknown','expired')
               AND expires_at<=statement_timestamp()-$2::integer*interval '1 second'
             ORDER BY expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
           )
           DELETE FROM cookie_identity.auth_mail_jobs AS job
           USING chosen WHERE job.id=chosen.id`,
          [batchSize, retentionSeconds],
        );
        if (result.rowCount === null) throw new Error("Auth mail purge failed");
        return result.rowCount;
      });
    },
  };
}
