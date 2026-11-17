import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { exchangeSelfServiceTelegram } from "../src/telegram-self-registration.js";

test("self-registration rejects invalid proofs before opening a transaction", async () => {
  let transactions = 0;
  const transaction = async <T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> => {
    void work;
    transactions++;
    throw new Error("unexpected transaction");
  };
  const verifier = { verify: () => null };
  assert.equal(
    await exchangeSelfServiceTelegram(
      transaction,
      verifier,
      Buffer.alloc(32),
      "invalid",
      true,
      900,
    ),
    null,
  );
  await assert.rejects(
    exchangeSelfServiceTelegram(
      transaction,
      verifier,
      Buffer.alloc(32),
      "invalid",
      true,
      0,
    ),
  );
  assert.equal(transactions, 0);
});

test("a proof expiring while waiting for the account lock cannot register", async () => {
  let checks = 0;
  let queries = 0;
  const verifier = {
    verify: () =>
      ++checks === 1
        ? {
            channel: "telegram-mini-app" as const,
            telegramUserId: "123",
            authDateUnixSeconds: 1,
          }
        : null,
  };
  const client = {
    query: async () => {
      queries++;
      return { rowCount: 0, rows: [] };
    },
  } as unknown as PoolClient;
  const transaction = async <T>(work: (client: PoolClient) => Promise<T>) =>
    work(client);
  const raw = "hash=" + "a".repeat(64);
  assert.equal(
    await exchangeSelfServiceTelegram(
      transaction,
      verifier,
      Buffer.alloc(32),
      raw,
      true,
      900,
    ),
    null,
  );
  assert.equal(checks, 2);
  assert.equal(queries, 1);
});
