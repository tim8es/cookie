import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Pool } from "pg";

import { createMigrationReadiness } from "../../../packages/platform-db/src/index.js";

test("migration readiness requires exact history on every probe", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cookie-ready-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const sql = "SELECT 1;";
  const sha256 = createHash("sha256").update(sql, "utf8").digest("hex");
  const first = { filename: "0001_first.sql", sha256 };
  const second = { filename: "0002_second.sql", sha256 };
  await writeFile(join(directory, first.filename), sql);
  await writeFile(join(directory, second.filename), sql);

  let rows = [second, first];
  let calls = 0;
  const database = {
    async query(statement: string) {
      calls++;
      assert.equal(
        statement,
        "SELECT filename, sha256 FROM public.cookie_schema_migrations",
      );
      return { rows };
    },
  } as unknown as Pick<Pool, "query">;
  const check = await createMigrationReadiness(database, directory);
  await check();

  for (const invalid of [
    [first],
    [first, second, { filename: "0003_future.sql", sha256 }],
    [first, { ...second, sha256: "0".repeat(64) }],
    [first, { filename: "0002_unknown.sql", sha256 }],
    [first, first],
  ]) {
    rows = invalid;
    await assert.rejects(check(), /migration history/);
  }
  rows = [first, second];
  await check();
  assert.equal(calls, 7);
});

test("runtime rejects an absent, empty or invalid migration manifest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cookie-ready-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const database = {
    async query() {
      assert.fail("invalid release must not query the database");
    },
  } as unknown as Pick<Pool, "query">;

  await assert.rejects(
    createMigrationReadiness(database, join(directory, "missing")),
  );
  await assert.rejects(
    createMigrationReadiness(database, directory),
    /No SQL migration files/,
  );
  await writeFile(join(directory, "0001_first.sql"), "SELECT 1;");
  await writeFile(join(directory, "0001_duplicate.sql"), "SELECT 2;");
  await assert.rejects(
    createMigrationReadiness(database, directory),
    /Duplicate migration sequence/,
  );
});
