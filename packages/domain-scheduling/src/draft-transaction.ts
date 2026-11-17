import type { Pool, PoolClient } from "pg";

/** Own transaction cleanup only when a trusted caller did not supply a client. */
export async function withDraftTransaction<T>(
  pool: Pool,
  existing: PoolClient | undefined,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (existing) return work(existing);
  const client = await pool.connect();
  let discard = true;
  try {
    const begun = await client.query("BEGIN");
    if (begun.command !== "BEGIN") throw new Error("Draft BEGIN failed");
    let result: T;
    try {
      result = await work(client);
    } catch (error) {
      const rolledBack = await client.query("ROLLBACK");
      if (rolledBack.command !== "ROLLBACK") {
        throw new Error("Draft ROLLBACK failed");
      }
      discard = false;
      throw error;
    }
    const committed = await client.query("COMMIT");
    if (committed.command !== "COMMIT") {
      throw new Error("Draft COMMIT failed");
    }
    discard = false;
    return result;
  } finally {
    // Uncertain BEGIN/COMMIT/ROLLBACK: never reuse the connection or retry.
    client.release(discard);
  }
}
