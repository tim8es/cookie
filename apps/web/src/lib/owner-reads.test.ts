import assert from "node:assert/strict";
import test from "node:test";

import { createOwnerRead, createOwnerReads } from "./owner-reads";

function deferredNumber() {
  let resolve!: (value: number) => void;
  const promise = new Promise<number>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("workspace coalesces pending reads but rechecks every settled read", async () => {
  let calls = 0;
  const slot = createOwnerRead(
    async () => ++calls,
    () => true,
  );

  assert.deepEqual(await Promise.all([slot.load(), slot.load()]), [1, 1]);
  assert.equal(await slot.load(), 2);
  assert.deepEqual(await Promise.all([slot.load(), slot.load()]), [3, 3]);
  assert.equal(calls, 3);
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
  assert.equal(calls, 3);
});

test("failed reads retry and a closed session discards in-flight data", async () => {
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
  await assert.rejects(slot.load(), /unauthorized/);

  const pending = slot.load();
  active = false;
  slow.resolve(2);
  await assert.rejects(pending, /session ended/);
  await assert.rejects(slot.load(), /session ended/);
  assert.equal(calls, 3);
});

for (const status of [401, 403]) {
  test(`protected read ${status} closes only the exact workspace`, async () => {
    const session = {
      accessToken: "cs_" + "x".repeat(43),
      tenantId: "00000000-0000-4000-8000-000000000001",
      expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 300,
    };
    let denied = 0;
    let requests = 0;
    let release!: (value: Response) => void;
    const delayed = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetcher: typeof fetch = async (input) => {
      requests++;
      const path = String(input);
      if (path.endsWith("/services")) {
        return Response.json({ services: [] });
      }
      if (path.endsWith("/locations")) return delayed;
      return new Response(null, { status });
    };
    const reads = createOwnerReads(session, () => denied++, fetcher);
    const other = createOwnerReads(
      { ...session, tenantId: "00000000-0000-4000-8000-000000000002" },
      () => assert.fail("another workspace must not be closed"),
      fetcher,
    );
    await reads.services.load();
    await other.services.load();

    const slow = reads.locations.load();
    const rejected = assert.rejects(slow, /session ended/);
    await assert.rejects(reads.staff.load(), /unauthorized/);
    assert.equal(denied, 1);
    assert.deepEqual(await other.services.load(), []);

    release(Response.json({ locations: [] }));
    await rejected;
    await assert.rejects(reads.services.load(), /session ended/);
    assert.equal(requests, 5);
    reads.close();
    other.close();
  });
}
