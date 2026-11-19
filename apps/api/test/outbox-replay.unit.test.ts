import assert from "node:assert/strict";
import test from "node:test";

import type { Pool, PoolClient } from "pg";

import { replayDeadOutbox } from "../../../packages/platform-db/src/replay.js";

const request = {
  actor: {
    tenantId: "00000000-0000-4000-8000-000000000001",
    identityId: "00000000-0000-4000-8000-000000000002",
    correlationId: "synthetic-replay-transaction",
  },
  eventId: "00000000-0000-4000-8000-000000000003",
};

test("replay refuses a failed isolation setup before policy queries", async () => {
  const commands: string[] = [];
  const releases: boolean[] = [];
  const client = {
    async query(sql: string) {
      commands.push(sql);
      if (sql === "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE") {
        throw new Error("private driver error");
      }
      return { command: sql };
    },
    release(discard: boolean) {
      releases.push(discard);
    },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  await assert.rejects(replayDeadOutbox(pool, request), {
    message: "Outbox dead-letter replay refused",
  });
  assert.deepEqual(commands, [
    "BEGIN",
    "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
    "ROLLBACK",
  ]);
  assert.deepEqual(releases, [false]);
});

test("replay sanitizes pool acquisition failures", async () => {
  const pool = {
    async connect(): Promise<PoolClient> {
      throw new Error("private connection details");
    },
  } as unknown as Pool;
  await assert.rejects(replayDeadOutbox(pool, request), {
    message: "Outbox dead-letter replay refused",
  });
});
