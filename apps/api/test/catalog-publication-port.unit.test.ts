import assert from "node:assert/strict";
import { test } from "node:test";

import type { PoolClient } from "pg";

import { lockStagingServiceForPublication } from "../../../packages/domain-catalog/src/index.js";

function fixture(row?: { active: boolean; draft_revision: number }) {
  const calls: { sql: string; parameters: unknown[] }[] = [];
  const client = {
    async query(sql: string, parameters: unknown[]) {
      calls.push({ sql, parameters });
      return { rows: sql.startsWith("SELECT") && row ? [row] : [] };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

test("catalog publication fails closed for missing and stale revisions", async () => {
  const missing = fixture();
  const stale = fixture({ active: false, draft_revision: 1 });

  assert.deepEqual(
    await lockStagingServiceForPublication(missing.client, "tenant", "id", 2),
    { status: "missing" },
  );
  assert.deepEqual(
    await lockStagingServiceForPublication(stale.client, "tenant", "id", 2),
    { status: "stale" },
  );
  assert.equal(missing.calls.length, 1);
  assert.equal(stale.calls.length, 1);
});

test("catalog publication defers the scoped write until activation", async () => {
  const { client, calls } = fixture({ active: false, draft_revision: 2 });
  const publication = await lockStagingServiceForPublication(
    client,
    "tenant",
    "id",
    2,
  );
  if (publication.status !== "ready") assert.fail("expected locked service");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /FOR UPDATE$/);
  assert.deepEqual(calls[0]!.parameters, ["tenant", "id"]);

  await publication.activate();
  await publication.activate();
  assert.equal(calls.length, 2);
  assert.match(
    calls[1]!.sql,
    /UPDATE cookie_catalog\.services SET active=true,draft_revision=draft_revision\+1/,
  );
  assert.deepEqual(calls[1]!.parameters, ["tenant", "id"]);
});

test("catalog publication reuses an active shared service without a write", async () => {
  const { client, calls } = fixture({ active: true, draft_revision: 2 });
  const publication = await lockStagingServiceForPublication(
    client,
    "tenant",
    "id",
    2,
  );
  if (publication.status !== "ready") assert.fail("expected locked service");
  await publication.activate();
  assert.equal(calls.length, 1);
});
