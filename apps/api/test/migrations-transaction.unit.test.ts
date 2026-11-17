import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Pool, PoolClient } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

interface Faults {
  readonly fail?: string;
  readonly tag?: { readonly at: string; readonly value: string };
  readonly unlockFalse?: boolean;
}

function fixture(faults: Faults = {}) {
  const calls: string[] = [];
  const releases: boolean[] = [];
  const client = {
    async query(sql: string) {
      const step = sql.includes("pg_advisory_unlock")
        ? "unlock"
        : sql.includes("pg_advisory_lock")
          ? "lock"
          : sql.includes("CREATE TABLE IF NOT EXISTS")
            ? "history-table"
            : sql.startsWith("SELECT filename")
              ? "history-read"
              : sql.startsWith("INSERT INTO public.cookie_schema_migrations")
                ? "history-write"
                : sql === "SELECT 42;"
                  ? "migration"
                  : sql;
      calls.push(step);
      if (step === faults.fail) throw new Error("driver failure");
      return {
        command: faults.tag?.at === step ? faults.tag.value : sql,
        rows: step === "unlock" ? [{ unlocked: !faults.unlockFalse }] : [],
      };
    },
    release(discard: boolean) {
      releases.push(discard);
    },
  } as unknown as PoolClient;
  return {
    pool: { connect: async () => client } as unknown as Pool,
    calls,
    releases,
  };
}

async function withMigration(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "cookie-migration-unit-"));
  try {
    await writeFile(join(directory, "0001_test.sql"), "SELECT 42;");
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const prefix = ["lock", "history-table", "history-read"];
const work = [...prefix, "BEGIN", "migration", "history-write"];

test("migration runner reports success only after COMMIT and advisory unlock", async () => {
  await withMigration(async (directory) => {
    const f = fixture();
    assert.deepEqual(await runMigrations(f.pool, directory), ["0001_test.sql"]);
    assert.deepEqual(f.calls, [...work, "COMMIT", "unlock"]);
    assert.deepEqual(f.releases, [false]);
  });
});

test("migration runner discards uncertain lock acquisition and BEGIN", async () => {
  await withMigration(async (directory) => {
    for (const [faults, calls] of [
      [{ fail: "lock" }, ["lock"]],
      [{ fail: "BEGIN" }, [...prefix, "BEGIN"]],
      [
        { tag: { at: "BEGIN", value: "SELECT" } },
        [...prefix, "BEGIN"],
      ],
    ] as const) {
      const f = fixture(faults);
      await assert.rejects(runMigrations(f.pool, directory));
      assert.deepEqual(f.calls, calls);
      assert.deepEqual(f.releases, [true]);
    }
  });
});

test("migration runner rolls back a failed migration or history insert", async () => {
  await withMigration(async (directory) => {
    for (const step of ["migration", "history-write"]) {
      const f = fixture({ fail: step });
      await assert.rejects(runMigrations(f.pool, directory), /driver failure/);
      const untilFailure = work.slice(0, work.indexOf(step) + 1);
      assert.deepEqual(f.calls, [...untilFailure, "ROLLBACK"]);
      assert.deepEqual(f.releases, [true]);
    }
  });
});

test("migration runner fails closed when rollback is not acknowledged", async () => {
  await withMigration(async (directory) => {
    const f = fixture({
      fail: "migration",
      tag: { at: "ROLLBACK", value: "SELECT" },
    });
    await assert.rejects(
      runMigrations(f.pool, directory),
      /cleanup failed/,
    );
    assert.deepEqual(f.calls, [...prefix, "BEGIN", "migration", "ROLLBACK"]);
    assert.deepEqual(f.releases, [true]);
  });
});

test("migration runner never retries or unlocks after uncertain COMMIT", async () => {
  await withMigration(async (directory) => {
    for (const faults of [
      { fail: "COMMIT" },
      { tag: { at: "COMMIT", value: "ROLLBACK" } },
    ]) {
      const f = fixture(faults);
      await assert.rejects(runMigrations(f.pool, directory));
      assert.deepEqual(f.calls, [...work, "COMMIT"]);
      assert.deepEqual(f.releases, [true]);
    }
  });
});

test("migration runner fails and discards a session when unlock is uncertain", async () => {
  await withMigration(async (directory) => {
    for (const faults of [{ fail: "unlock" }, { unlockFalse: true }]) {
      const f = fixture(faults);
      await assert.rejects(runMigrations(f.pool, directory));
      assert.deepEqual(f.calls, [...work, "COMMIT", "unlock"]);
      assert.deepEqual(f.releases, [true]);
    }
  });
});
