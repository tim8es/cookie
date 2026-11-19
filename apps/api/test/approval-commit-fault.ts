import assert from "node:assert/strict";

import type { Pool, PoolClient } from "pg";

/** Test-only facade: the database performs the real transaction; only the
 * final acknowledgement is fault-injected, not a real network outage. */
export async function expectApprovalCommitFailure(
  realPool: Pool,
  mode: "abort" | "lose-ack",
  work: (pool: Pool) => Promise<unknown>,
): Promise<void> {
  const commands: string[] = [];
  const releases: boolean[] = [];
  let tag: string | undefined;
  const facade = {
    async connect(): Promise<PoolClient> {
      const physical = await realPool.connect();
      return {
        async query(sql: string, params?: unknown[]): Promise<unknown> {
          commands.push(sql);
          if (sql === "COMMIT") {
            if (mode === "abort") {
              await assert.rejects(physical.query("SELECT 1 / 0"), {
                code: "22012",
              });
            }
            const result = await physical.query(sql);
            tag = result.command;
            if (mode === "lose-ack") {
              throw new Error("SYNTHETIC_APPROVAL_COMMIT_ACK_LOST");
            }
            return result;
          }
          return physical.query(sql, params);
        },
        release(discard: boolean): void {
          releases.push(discard);
          physical.release(discard);
        },
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  await assert.rejects(work(facade), {
    message:
      mode === "abort"
        ? "SQL transaction did not commit"
        : "SYNTHETIC_APPROVAL_COMMIT_ACK_LOST",
  });
  assert.equal(tag, mode === "abort" ? "ROLLBACK" : "COMMIT");
  assert.deepEqual(releases, [true]);
  assert.equal(commands.filter((sql) => sql === "COMMIT").length, 1);
  assert.equal(commands.includes("ROLLBACK"), false);
}

const tables = [
  "cookie_scheduling.schedule_edit_policies",
  "cookie_scheduling.schedule_edit_policy_audit",
  "cookie_scheduling.schedule_edit_requests",
  "cookie_scheduling.schedule_publish_requests",
  "cookie_scheduling.shift_windows",
  "cookie_scheduling.shift_edit_audit",
  "cookie_scheduling.shift_edit_receipts",
  "cookie_scheduling.shift_publish_audit",
  "cookie_scheduling.shift_publish_receipts",
  "cookie_jobs.outbox_events",
  "cookie_booking.bookings",
  "cookie_identity.authorization_audit",
] as const;

/** Exact persisted state of the generated test tenant; stable row order. */
export async function approvalSnapshot(
  pool: Pool,
  tenantId: string,
  includeAuthorization = true,
): Promise<unknown[]> {
  const contents: unknown[] = [];
  for (const table of tables) {
    if (
      !includeAuthorization &&
      table === "cookie_identity.authorization_audit"
    ) {
      continue;
    }
    const result = await pool.query<{ rows: unknown }>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),
                       '[]'::jsonb) AS rows
         FROM ${table} t WHERE tenant_id=$1::uuid`,
      [tenantId],
    );
    assert.ok(result.rows[0]);
    contents.push(result.rows[0].rows);
  }
  return contents;
}
