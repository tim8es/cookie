import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";

import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/index.js";
import { runProtectedTransaction } from "../src/protected-tenant-transaction.js";

function fixture(
  failed?: string,
  commandOverride?: string,
): {
  pool: Pool;
  client: PoolClient;
  calls: string[];
  releases: boolean[];
} {
  const calls: string[] = [];
  const releases: boolean[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql === failed) throw new Error("simulated connection failure");
      return {
        command: sql === "COMMIT" && commandOverride ? commandOverride : sql,
      };
    },
    release(discard: boolean) {
      releases.push(discard);
    },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, client, calls, releases };
}

test("protected transaction returns value only after successful commit", async () => {
  const f = fixture();
  const result = await runProtectedTransaction(
    f.pool,
    async (client) => {
      assert.equal(client, f.client);
      f.calls.push("policy");
    },
    async (client) => {
      assert.equal(client, f.client);
      f.calls.push("work");
      return "saved";
    },
  );
  assert.equal(result, "saved");
  assert.deepEqual(f.calls, ["BEGIN", "policy", "work", "COMMIT"]);
  assert.deepEqual(f.releases, [false]);
});

test("denied policy commits audit without executing business work", async () => {
  const f = fixture();
  const denied = new AuthorizationDeniedError();
  await assert.rejects(
    runProtectedTransaction(
      f.pool,
      async () => {
        f.calls.push("policy");
        throw denied;
      },
      async () => assert.fail("business work must not run"),
    ),
    (reason) => reason === denied,
  );
  assert.deepEqual(f.calls, ["BEGIN", "policy", "COMMIT"]);
  assert.deepEqual(f.releases, [false]);
});

test("failed denial audit commit is unavailable and discards connection", async () => {
  const f = fixture("COMMIT");
  await assert.rejects(
    runProtectedTransaction(
      f.pool,
      async () => {
        throw new AuthorizationDeniedError();
      },
      async () => assert.fail("business work must not run"),
    ),
    /simulated connection failure/,
  );
  assert.deepEqual(f.calls, ["BEGIN", "COMMIT"]);
  assert.deepEqual(f.releases, [true]);
});

test("business error rolls back and safely reuses only a clean connection", async () => {
  const f = fixture();
  const failure = new Error("work failure");
  await assert.rejects(
    runProtectedTransaction(
      f.pool,
      async () => {},
      async () => {
        throw failure;
      },
    ),
    (reason) => reason === failure,
  );
  assert.deepEqual(f.calls, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(f.releases, [false]);
});

test("failed rollback discards connection instead of hiding cleanup failure", async () => {
  const f = fixture("ROLLBACK");
  await assert.rejects(
    runProtectedTransaction(
      f.pool,
      async () => {},
      async () => {
        throw new Error("work failure");
      },
    ),
    /cleanup failed/,
  );
  assert.deepEqual(f.calls, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(f.releases, [true]);
});

test("failed or rolled-back COMMIT never returns successful work result", async () => {
  for (const f of [fixture("COMMIT"), fixture(undefined, "ROLLBACK")]) {
    await assert.rejects(
      runProtectedTransaction(
        f.pool,
        async () => {},
        async () => "must not appear",
      ),
    );
    assert.deepEqual(f.calls, ["BEGIN", "COMMIT"]);
    assert.deepEqual(f.releases, [true]);
  }
});

test("failed BEGIN discards connection without invoking policy or work", async () => {
  const f = fixture("BEGIN");
  await assert.rejects(
    runProtectedTransaction(
      f.pool,
      async () => assert.fail("policy must not run"),
      async () => assert.fail("business work must not run"),
    ),
    /simulated connection failure/,
  );
  assert.deepEqual(f.calls, ["BEGIN"]);
  assert.deepEqual(f.releases, [true]);
});
