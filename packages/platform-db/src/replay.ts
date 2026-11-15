import { randomUUID } from "node:crypto";

import type { Pool, QueryResultRow } from "pg";

import {
  requireSensitiveAuthorization,
  type TrustedActor,
} from "../../platform-identity/src/authorization.js";
import {
  loadPolicySnapshot,
  PostgresPolicyAudit,
} from "../../platform-identity/src/postgres.js";

interface DeadRow extends QueryResultRow {
  status: string;
  attempts: number;
  manual_replay_count: number;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DeadLetterReplayRequest {
  /** Authenticated server context ONLY, never browser/Telegram JSON. */
  readonly actor: TrustedActor;
  readonly eventId: string;
}

export interface DeadLetterReplayResult {
  readonly requeued: boolean;
  readonly replayCount: number | null;
}

/**
 * Owner-only, explicitly permissioned server-internal command. Never expose
 * this as a public endpoint. Both authZ preflight and mutation audit commit
 * in the same SERIALIZABLE transaction as the single dead->pending transition.
 *
 * The original event ID is deliberately stable across manual replays: a
 * future provider adapter MUST reuse this ID as its idempotency key.
 */
export async function replayDeadOutbox(
  pool: Pool,
  request: DeadLetterReplayRequest,
): Promise<DeadLetterReplayResult> {
  const { actor, eventId } = request;
  if (
    !UUID_PATTERN.test(actor.tenantId) ||
    !UUID_PATTERN.test(actor.identityId) ||
    !UUID_PATTERN.test(eventId) ||
    !actor.correlationId ||
    actor.correlationId.length > 128
  ) {
    throw new Error("Invalid trusted replay metadata");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const snapshot = await loadPolicySnapshot(client, actor);
    await requireSensitiveAuthorization(
      {
        actor,
        resource: { kind: "organization", tenantId: actor.tenantId },
        permission: "outbox.replay",
        ownerProtected: true,
      },
      snapshot,
      new PostgresPolicyAudit(client),
    );

    const selected = await client.query<DeadRow>(
      `SELECT status, attempts, manual_replay_count
       FROM cookie_jobs.outbox_events
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       FOR UPDATE`,
      [eventId, actor.tenantId],
    );
    const row = selected.rows[0];
    if (!row || row.status !== "dead" || row.manual_replay_count >= 3) {
      await client.query("COMMIT");
      return {
        requeued: false,
        replayCount: row?.manual_replay_count ?? null,
      };
    }

    const replayCount = row.manual_replay_count + 1;
    await client.query(
      `UPDATE cookie_jobs.outbox_events
       SET status = 'pending', attempts = 0,
           available_at = clock_timestamp(), lease_token = NULL,
           lease_until = NULL, delivered_at = NULL,
           last_failure_code = NULL, manual_replay_count = $3
       WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = 'dead'`,
      [eventId, actor.tenantId, replayCount],
    );
    await client.query(
      `INSERT INTO cookie_jobs.outbox_replay_audit
         (id, tenant_id, event_id, actor_identity_id, correlation_id,
          replay_number, previous_attempts)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7)`,
      [
        randomUUID(),
        actor.tenantId,
        eventId,
        actor.identityId,
        actor.correlationId,
        replayCount,
        row.attempts,
      ],
    );
    await client.query("COMMIT");
    return { requeued: true, replayCount };
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    // Do not surface driver SQL details, payloads, or auth-specific metadata.
    throw new Error("Outbox dead-letter replay refused");
  } finally {
    client.release();
  }
}
