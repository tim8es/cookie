import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { assessLegacyTelegramMigration } from "../src/legacy-telegram-migration-preflight.js";

const proof = {
  channel: "telegram-mini-app" as const,
  telegramUserId: "123",
  authDateUnixSeconds: 1,
};
const eligible = {
  legacy_count: 1,
  eligible_count: 1,
  global_conflict: false,
  other_legacy: false,
  membership_count: 1,
  consumed_proof: false,
  email_provider: false,
  active_role_count: 1,
  unsupported_role: false,
};

test("migration assessment rejects invalid proof before SQL", async () => {
  const transaction = async <T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> => {
    void work;
    throw new Error("unexpected transaction");
  };
  assert.equal(
    await assessLegacyTelegramMigration(
      transaction,
      { verify: () => null },
      Buffer.alloc(32),
      "invalid",
    ),
    "invalid-proof",
  );
});

test("migration assessment rechecks proof after fingerprint lock", async () => {
  let checks = 0;
  let queries = 0;
  const client = {
    query: async () => {
      queries++;
      return { rows: [] };
    },
  } as unknown as PoolClient;
  assert.equal(
    await assessLegacyTelegramMigration(
      async (work) => work(client),
      { verify: () => (++checks === 1 ? proof : null) },
      Buffer.alloc(32),
      "hash=" + "a".repeat(64),
    ),
    "invalid-proof",
  );
  assert.equal(queries, 1);
});

test("migration assessment is read-only and rejects every ambiguous class", async () => {
  for (const [row, expected] of [
    [{ ...eligible, legacy_count: 0 }, "no-legacy-link"],
    [{ ...eligible, legacy_count: 2 }, "ambiguous-legacy-history"],
    [{ ...eligible, eligible_count: 0 }, "inactive-or-unverified"],
    [{ ...eligible, global_conflict: true }, "global-link-conflict"],
    [{ ...eligible, other_legacy: true }, "other-legacy-link"],
    [{ ...eligible, membership_count: 2 }, "additional-memberships"],
    [{ ...eligible, consumed_proof: true }, "consumed-proof"],
    [{ ...eligible, email_provider: true }, "existing-email-provider"],
    [{ ...eligible, active_role_count: 0 }, "role-scope-review"],
    [{ ...eligible, unsupported_role: true }, "role-scope-review"],
    [eligible, "candidate-for-review"],
  ] as const) {
    const seen: string[] = [];
    const client = {
      query: async (sql: string) => {
        seen.push(sql);
        return { rows: [row] };
      },
    } as unknown as PoolClient;
    assert.equal(
      await assessLegacyTelegramMigration(
        async (work) => work(client),
        { verify: () => proof },
        Buffer.alloc(32),
        "hash=" + "a".repeat(64),
      ),
      expected,
    );
    assert.equal(seen.length, 2);
    assert.match(seen[0]!, /pg_advisory_xact_lock/);
    assert.match(seen[1]!, /^WITH legacy AS/);
    assert.doesNotMatch(seen[1]!, /\b(?:INSERT|UPDATE|DELETE)\b/i);
  }
});
