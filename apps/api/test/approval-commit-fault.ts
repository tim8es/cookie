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

/** Exercise the FIRST successful request COMMIT, not a receipt-only replay. */
export async function recoverNewApprovalRequestAfterLostAck<
  T extends { readonly requestId: string; readonly status: string },
>(
  pool: Pool,
  tenantId: string,
  kind: "edit" | "publish",
  work: (pool: Pool) => Promise<T>,
): Promise<T> {
  const table =
    kind === "edit"
      ? "cookie_scheduling.schedule_edit_requests"
      : "cookie_scheduling.schedule_publish_requests";
  const topic = `schedule.${kind}.requested`;
  const requests = async () =>
    (
      await pool.query<{ id: string; status: string }>(
        `SELECT id::text,status FROM ${table}
          WHERE tenant_id=$1::uuid ORDER BY id`,
        [tenantId],
      )
    ).rows;
  const before = await requests();
  const beforeState = await approvalSnapshot(pool, tenantId, false);
  await expectApprovalCommitFailure(pool, "lose-ack", work);

  // Independently observe the first actual COMMIT before any retry.
  const committed = await requests();
  assert.equal(committed.length, before.length + 1);
  const added = committed.filter(
    (row) => !before.some((old) => old.id === row.id),
  );
  assert.equal(added.length, 1);
  assert.deepEqual(
    committed.filter((row) => row.id !== added[0]!.id),
    before,
  );
  assert.equal(added[0]!.status, "pending");
  const requestId = added[0]!.id;
  const events = await pool.query<{ dedupe_key: string }>(
    `SELECT dedupe_key FROM cookie_jobs.outbox_events
      WHERE tenant_id=$1::uuid AND topic=$2
        AND payload->>'requestId'=$3`,
    [tenantId, topic, requestId],
  );
  assert.deepEqual(events.rows, [{ dedupe_key: `${topic}:${requestId}` }]);

  const committedState = await approvalSnapshot(pool, tenantId, false);
  // Only the new request and its event can change, no shift/booking/review.
  const changed = tables
    .filter((name) => name !== "cookie_identity.authorization_audit")
    .filter(
      (_, index) =>
        JSON.stringify(beforeState[index]) !==
        JSON.stringify(committedState[index]),
    );
  assert.deepEqual(changed, [table, "cookie_jobs.outbox_events"]);
  const recovered = await work(pool);
  assert.equal(recovered.requestId, requestId);
  assert.equal(recovered.status, "pending");
  assert.deepEqual(
    await approvalSnapshot(pool, tenantId, false),
    committedState,
  );
  return recovered;
}
