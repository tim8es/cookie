import assert from "node:assert/strict";
import test from "node:test";

import { watchOwnerSessionExpiry } from "./owner-auth";

function fixture() {
  let ms = 1000;
  let pending: (() => void) | undefined;
  const win = Object.assign(new EventTarget(), {
    setTimeout(callback: () => void) {
      pending = callback;
      return 1;
    },
    clearTimeout() {
      pending = undefined;
    },
  }) as unknown as Window;
  const doc = new EventTarget() as unknown as Document;
  return {
    win,
    doc,
    now: () => ms,
    advance: (value: number) => {
      ms = value;
    },
    fire: () => pending?.(),
  };
}

test("owner expiry clears access once even after tab resumes", () => {
  const f = fixture();
  let count = 0;
  const expire = () => count++;
  const stop = watchOwnerSessionExpiry(2, expire, f.win, f.doc, f.now);
  f.advance(1500);
  f.fire();
  assert.equal(count, 0);
  f.advance(2000);
  f.doc.dispatchEvent(new Event("visibilitychange"));
  f.win.dispatchEvent(new Event("focus"));
  f.fire();
  assert.equal(count, 1);
  stop();
});

test("owner expiry watcher stops on logout or unmount", () => {
  const f = fixture();
  const expire = () => assert.fail("watcher must be stopped");
  const stop = watchOwnerSessionExpiry(2, expire, f.win, f.doc, f.now);
  stop();
  f.advance(3000);
  f.fire();
  f.win.dispatchEvent(new Event("pageshow"));
});

test("already expired sessions fail closed immediately", () => {
  const f = fixture();
  let count = 0;
  const expire = () => count++;
  watchOwnerSessionExpiry(1, expire, f.win, f.doc, f.now);
  assert.equal(count, 1);
  f.fire();
  assert.equal(count, 1);
});
