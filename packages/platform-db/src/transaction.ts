import type { Pool, PoolClient } from "pg";

/**
 * Own one SQL transaction. Return the result only after an acknowledged COMMIT,
 * never retry work here, and destroy connections with ambiguous protocol state.
 * The caller controls authorization and business/audit rollback semantics.
 */
export async function runSqlTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let state: "starting" | "open" | "committing" | "finished" = "starting";
  let discard = false;
  let clientFailed = false;
  // A checked-out pg Client can emit an error independently of rejecting its
  // active query. The pool only owns idle-client errors. Keep the failed
  // client guarded through disposal; never log raw driver errors here.
  const onClientError = (): void => {
    clientFailed = true;
  };
  // Structural test doubles may implement only query/release.
  client.on?.("error", onClientError);
  const assertConnected = (): void => {
    if (clientFailed) throw new Error("SQL transaction connection failed");
  };
  try {
    const begun = await client.query("BEGIN");
    assertConnected();
    if (begun.command !== "BEGIN") {
      throw new Error("SQL transaction did not begin");
    }
    state = "open";
    const result = await work(client);
    assertConnected();
    state = "committing";
    const committed = await client.query("COMMIT");
    assertConnected();
    if (committed.command !== "COMMIT") {
      // PostgreSQL can report ROLLBACK in response to COMMIT if a prior
      // statement aborted the transaction, even without a driver exception.
      throw new Error("SQL transaction did not commit");
    }
    state = "finished";
    return result;
  } catch (error) {
    if (clientFailed) {
      // A broken physical connection cannot acknowledge rollback; discard it.
      discard = true;
    } else if (state === "open") {
      try {
        const rolledBack = await client.query("ROLLBACK");
        assertConnected();
        if (rolledBack.command !== "ROLLBACK") {
          throw new Error("SQL transaction did not roll back");
        }
      } catch {
        discard = true;
        throw new Error("SQL transaction cleanup failed");
      }
    } else if (state !== "finished") {
      // BEGIN or COMMIT acknowledgement lost: don't issue another SQL
      // command on this connection. Same-key retry belongs to the caller.
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard || clientFailed);
    // pg installs its idle error handler on a healthy release. A discarded
    // client will never be pooled again; retain this listener for late errors
    // until the destroyed connection is garbage-collected.
    if (!discard && !clientFailed) {
      client.removeListener?.("error", onClientError);
    }
  }
}
