import assert from "node:assert/strict";
import test from "node:test";

import {
  PasswordWorkBusy,
  PasswordWorkGate,
} from "../src/password-work-gate.js";

test("password work gate rejects overload and releases capacity on completion", async () => {
  const gate = new PasswordWorkGate(1);
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const first = gate.run(() => blocked);
  await assert.rejects(
    gate.run(async () => assert.fail("overloaded work must not run")),
    PasswordWorkBusy,
  );
  finish();
  await first;
  assert.equal(await gate.run(async () => 42), 42);
  await assert.rejects(
    gate.run(async () => {
      throw new Error("synthetic failure");
    }),
    /synthetic failure/,
  );
  assert.equal(await gate.run(async () => 7), 7);
});

test("password work gate rejects unbounded or invalid capacity", () => {
  for (const capacity of [0, -1, 1.5, 5, Infinity, NaN]) {
    assert.throws(() => new PasswordWorkGate(capacity));
  }
});
