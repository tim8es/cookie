import assert from "node:assert/strict";
import test from "node:test";

import { createOwnerRead } from "./owner-reads";

function deferredNumber() {
  let resolve!: (value: number) => void;
  const promise = new Promise<number>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("workspace shows recent data immediately and shares the refresh", async () => {
  let now = 1_000;
  let calls = 0;
  const slot = createOwnerRead(
    async () => ++calls,
    () => true,
    () => now,
  );

  assert.deepEqual(await Promise.all([slot.load(), slot.load()]), [1, 1]);
  assert.equal(await slot.load(), 1);
  now += 6_000;
  assert.equal(slot.peek(), 1);
  assert.deepEqual(await Promise.all([slot.load(), slot.load()]), [2, 2]);
  assert.equal(await slot.load(true), 3);
  now += 30_000;
  assert.equal(slot.peek(), undefined);
});

test("a late response started before a write cannot restore the old data", async () => {
  const previous = deferredNumber();
  let calls = 0;
  const slot = createOwnerRead(
    () => (++calls === 1 ? previous.promise : Promise.resolve(2)),
    () => true,
  );

  const beforeWrite = slot.load();
  slot.invalidate();
  assert.equal(await slot.load(), 2);
  previous.resolve(1);
  assert.equal(await beforeWrite, 2);
  assert.equal(slot.peek(), 2);
});

test("an API rejection clears the snapshot and closing the session discards in-flight data", async () => {
  const slow = deferredNumber();
  let active = true;
  let calls = 0;
  const slot = createOwnerRead(
    async () => {
      calls++;
      if (calls === 2) throw new Error("unauthorized");
      return calls === 1 ? 1 : slow.promise;
    },
    () => active,
  );

  assert.equal(await slot.load(), 1);
  await assert.rejects(slot.load(true), /unauthorized/);
  assert.equal(slot.peek(), undefined);

  const pending = slot.load();
  active = false;
  slow.resolve(2);
  await assert.rejects(pending, /session ended/);
  assert.equal(slot.peek(), undefined);
  await assert.rejects(slot.load(), /session ended/);
  assert.equal(calls, 3);
});
