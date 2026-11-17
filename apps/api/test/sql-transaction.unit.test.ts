import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Pool, PoolClient } from "pg";

import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";

function fixture(fail?: string, override?: string) {
  const calls: string[] = [];
  const releases: boolean[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql === fail) throw new Error("driver failure");
      return { command: sql === "COMMIT" && override ? override : sql };
    },
    release(discard: boolean) {
      releases.push(discard);
    },
  } as unknown as PoolClient;
  return {
    pool: { connect: async () => client } as unknown as Pool,
    client,
    calls,
    releases,
  };
}

test("SQL transaction returns work result only after COMMIT acknowledgement", async () => {
  const f = fixture();
  const result = await runSqlTransaction(f.pool, async (client) => {
    assert.equal(client, f.client);
    f.calls.push("work");
    return "receipt";
  });
  assert.equal(result, "receipt");
  assert.deepEqual(f.calls, ["BEGIN", "work", "COMMIT"]);
  assert.deepEqual(f.releases, [false]);
});

test("SQL transaction rolls back a work failure and reuses only a clean connection", async () => {
  const f = fixture();
  const failure = new Error("work failed");
  await assert.rejects(
    runSqlTransaction(f.pool, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(f.calls, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(f.releases, [false]);
});

test("SQL transaction discards a connection if rollback fails", async () => {
  const f = fixture("ROLLBACK");
  await assert.rejects(
    runSqlTransaction(f.pool, async () => {
      throw new Error("work failed");
    }),
    /cleanup failed/,
  );
  assert.deepEqual(f.calls, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(f.releases, [true]);
});

test("SQL transaction never retries or rolls back an uncertain COMMIT", async () => {
  for (const f of [fixture("COMMIT"), fixture(undefined, "ROLLBACK")]) {
    let invoked = 0;
    await assert.rejects(
      runSqlTransaction(f.pool, async () => {
        invoked++;
        return "must not return";
      }),
    );
    assert.equal(invoked, 1);
    assert.deepEqual(f.calls, ["BEGIN", "COMMIT"]);
    assert.deepEqual(f.releases, [true]);
  }
});

test("SQL transaction discards a connection when BEGIN fails", async () => {
  const f = fixture("BEGIN");
  await assert.rejects(
    runSqlTransaction(f.pool, async () => assert.fail("work must not run")),
    /driver failure/,
  );
  assert.deepEqual(f.calls, ["BEGIN"]);
  assert.deepEqual(f.releases, [true]);
});

test("checked-out connection error fails closed without an unhandled event", async () => {
  for (const phase of ["BEGIN", "work", "COMMIT"]) {
    const events = new EventEmitter();
    const calls: string[] = [];
    const releases: boolean[] = [];
    const client = Object.assign(events, {
      async query(sql: string) {
        calls.push(sql);
        if (sql === phase) events.emit("error", new Error("connection lost"));
        return { command: sql };
      },
      release(discard: boolean) {
        releases.push(discard);
      },
    }) as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    await assert.rejects(
      runSqlTransaction(pool, async () => {
        calls.push("work");
        if (phase === "work") events.emit("error", new Error("lost socket"));
        return "must not return";
      }),
      /SQL transaction connection failed/,
    );
    const expected =
      phase === "BEGIN"
        ? ["BEGIN"]
        : phase === "work"
          ? ["BEGIN", "work"]
          : ["BEGIN", "work", "COMMIT"];
    assert.deepEqual(calls, expected);
    assert.deepEqual(releases, [true]);
    assert.doesNotThrow(() => events.emit("error", new Error("late event")));
  }
});

test("healthy transaction does not retain a checked-out error listener", async () => {
  const events = new EventEmitter();
  const client = Object.assign(events, {
    async query(sql: string) {
      return { command: sql };
    },
    release(discard: boolean) {
      assert.equal(discard, false);
    },
  }) as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  for (let index = 0; index < 3; index++) {
    await runSqlTransaction(pool, async () => {
      assert.equal(events.listenerCount("error"), 1);
    });
    assert.equal(events.listenerCount("error"), 0);
  }
});
