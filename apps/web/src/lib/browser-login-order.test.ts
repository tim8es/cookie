import assert from "node:assert/strict";
import test from "node:test";

import { withBrowserLogin } from "./browser-login-order.js";

test("browser login holds one origin lock through the complete operation", async () => {
  let tail: Promise<unknown> = Promise.resolve();
  const requests: string[] = [];
  const locks = {
    request<T>(
      name: string,
      options: { mode: string },
      callback: () => Promise<T>,
    ): Promise<T> {
      requests.push(name);
      assert.equal(options.mode, "exclusive");
      const result = tail.then(callback);
      tail = result.catch(() => undefined);
      return result;
    },
  } as unknown as LockManager;
  const browser = { navigator: { locks } };
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const events: string[] = [];
  const first = withBrowserLogin(browser, async (canPersist) => {
    assert.equal(canPersist, true);
    events.push("first provider");
    entered();
    await held;
    events.push("first readback");
  });
  await started;
  const second = withBrowserLogin(browser, async (canPersist) => {
    assert.equal(canPersist, true);
    events.push("second provider and bind");
  });
  await Promise.resolve();
  assert.deepEqual(events, ["first provider"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(requests, ["kuki-browser-login-v1", "kuki-browser-login-v1"]);
  assert.deepEqual(events, [
    "first provider",
    "first readback",
    "second provider and bind",
  ]);
});

test("missing Web Locks permits tab-only work, not shared persistence", async () => {
  assert.equal(
    await withBrowserLogin({ navigator: {} }, async (canPersist) => canPersist),
    false,
  );
});

test("a rejected lock request does not retry without coordination", async () => {
  let called = false;
  const locks = {
    request: async () => {
      throw new Error("Lock rejected");
    },
  } as unknown as LockManager;
  await assert.rejects(
    withBrowserLogin({ navigator: { locks } }, async () => {
      called = true;
    }),
    /Lock rejected/,
  );
  assert.equal(called, false);
});
