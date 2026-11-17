import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";

import { withDraftTransaction } from "../src/draft-transaction.js";

function fixture(failed?: string, wrongCommit = false) {
  const calls: string[] = [];
  const releases: boolean[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql === failed) throw new Error("injected SQL failure");
      return { command: wrongCommit && sql === "COMMIT" ? "ROLLBACK" : sql };
    },
    release(discard: boolean) {
      releases.push(discard);
    },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { client, pool, calls, releases };
}

test("draft command only returns after commit", async () => {
  const f = fixture();
  const value = await withDraftTransaction(f.pool, undefined, async () => 1);
  assert.equal(value, 1);
  assert.deepEqual(f.calls, ["BEGIN", "COMMIT"]);
  assert.deepEqual(f.releases, [false]);
});

test("draft failures roll back; uncertain close discards the connection", async () => {
  for (const failed of [undefined, "ROLLBACK"]) {
    const f = fixture(failed);
    await assert.rejects(
      withDraftTransaction(f.pool, undefined, async () => {
        throw new Error("work failed");
      }),
    );
    assert.deepEqual(f.calls, ["BEGIN", "ROLLBACK"]);
    assert.deepEqual(f.releases, [Boolean(failed)]);
  }
});

test("failed or rolled-back commit never returns success", async () => {
  for (const f of [fixture("COMMIT"), fixture(undefined, true)]) {
    await assert.rejects(
      withDraftTransaction(f.pool, undefined, async () => 1),
    );
    assert.deepEqual(f.calls, ["BEGIN", "COMMIT"]);
    assert.deepEqual(f.releases, [true]);
  }
});

test("failed BEGIN never starts business work", async () => {
  const f = fixture("BEGIN");
  await assert.rejects(
    withDraftTransaction(f.pool, undefined, async () => assert.fail()),
  );
  assert.deepEqual(f.calls, ["BEGIN"]);
  assert.deepEqual(f.releases, [true]);
});

test("caller-owned transactions are never closed or released", async () => {
  const f = fixture();
  const result = await withDraftTransaction(f.pool, f.client, async (client) => {
    assert.equal(client, f.client);
    return 1;
  });
  assert.equal(result, 1);
  await assert.rejects(
    withDraftTransaction(f.pool, f.client, async () => {
      throw new Error("caller must roll back");
    }),
  );
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.releases, []);
});
