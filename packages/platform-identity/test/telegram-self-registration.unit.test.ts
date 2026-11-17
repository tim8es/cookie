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
