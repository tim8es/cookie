import assert from "node:assert/strict";
import { test } from "node:test";
import { BookingAttempt } from "./booking-attempt";
import { TransportFailure } from "./transport";

type Selection = { slot: string };
const selection: Selection = { slot: "10:00" };
const receipt = {
  id: "synthetic-booking-only",
  time: "10:00",
  finalPriceRub: 1250,
};
const acknowledged = Symbol("synthetic-confirmed-response");

function verifyConfirmed(raw: unknown) {
  return raw === acknowledged ? receipt : null;
}

test("never confirms before a verified server acknowledgement", async () => {
  let release: (value: unknown) => void = () => {};
  let calls = 0;
  const deferred = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const port = {
    create: async () => {
      calls++;
      return deferred;
    },
    verifyConfirmed,
    refreshSlots: async () => ["11:00"],
  };
  const flow = new BookingAttempt(port, () => "synthetic-key");
  const pending = flow.submit(selection);
  assert.equal(flow.getState().phase, "submitting");
  assert.equal(flow.reset(), false);
  const duplicate = flow.submit({ slot: "12:00" });
  assert.equal(calls, 1);
  release(acknowledged);
  const state = await pending;
  assert.equal(await duplicate, state);
  assert.equal(state.phase, "confirmed");
  if (state.phase === "confirmed") {
    assert.deepEqual(state.receipt, receipt);
  }
  assert.equal(flow.reset(), true);
  assert.equal(flow.getState().phase, "idle");
});

test("Pending or unknown responses cannot become Confirmed", async () => {
  let calls = 0;
  const keys: string[] = [];
  const port = {
    create: async (_selection: Selection, key: string) => {
      keys.push(key);
      calls++;
      return calls === 1 ? { syntheticPending: true } : acknowledged;
    },
    verifyConfirmed,
    refreshSlots: async () => ["11:00"],
  };
  const flow = new BookingAttempt(port, () => "same-retry-key");
  const first = await flow.submit(selection);
  assert.equal(first.phase, "error");
  if (first.phase === "error") {
    assert.equal(first.reason, "unverified-response");
    assert.equal(first.retryable, true);
  }
  assert.equal(flow.reset(), false);
  await flow.submit({ slot: "12:00" });
  assert.equal(calls, 1);
  const second = await flow.retry();
  assert.equal(second.phase, "confirmed");
  assert.deepEqual(keys, ["same-retry-key", "same-retry-key"]);
});

test("409 conflict refreshes slots but never confirms the booking", async () => {
  let refreshCalls = 0;
  const port = {
    create: async () => {
      throw new TransportFailure("conflict", 409);
    },
    verifyConfirmed,
    refreshSlots: async () => {
      refreshCalls++;
      return ["12:00", "14:00"];
    },
  };
  const flow = new BookingAttempt(port, () => "synthetic-key");
  const state = await flow.submit(selection);
  assert.equal(state.phase, "conflict");
  if (state.phase === "conflict") {
    assert.deepEqual(state.slots, ["12:00", "14:00"]);
    assert.equal(state.refreshFailed, false);
  }
  assert.equal(refreshCalls, 1);
  assert.equal(flow.reset(), true);
});

test("a failed refresh still shows conflict, never fake availability", async () => {
  const port = {
    create: async () => {
      throw new TransportFailure("conflict", 409);
    },
    verifyConfirmed,
    refreshSlots: async () => {
      throw new TypeError("Synthetic offline");
    },
  };
  const flow = new BookingAttempt(port, () => "synthetic-key");
  const state = await flow.submit(selection);
  assert.equal(state.phase, "conflict");
  if (state.phase === "conflict") {
    assert.deepEqual(state.slots, []);
    assert.equal(state.refreshFailed, true);
  }
});

test("network retry reuses the same idempotency key explicitly", async () => {
  const keys: string[] = [];
  let calls = 0;
  const port = {
    create: async (_selection: Selection, key: string) => {
      keys.push(key);
      calls++;
      if (calls === 1) throw new TransportFailure("network");
      return acknowledged;
    },
    verifyConfirmed,
    refreshSlots: async () => ["11:00"],
  };
  const flow = new BookingAttempt(port, () => "stable-synthetic-key");
  const failed = await flow.submit(selection);
  assert.equal(failed.phase, "error");
  assert.equal(calls, 1);
  assert.equal(flow.reset(), false);
  const ignored = await flow.submit({ slot: "12:00" });
  assert.equal(ignored.phase, "error");
  assert.equal(calls, 1);
  const retried = await flow.retry();
  assert.equal(retried.phase, "confirmed");
  assert.deepEqual(keys, ["stable-synthetic-key", "stable-synthetic-key"]);
  assert.equal(calls, 2);
});

test("401 and 403 deny without retry or false confirmation", async () => {
  for (const kind of ["unauthenticated", "forbidden"] as const) {
    let calls = 0;
    const port = {
      create: async () => {
        calls++;
        throw new TransportFailure(kind, kind === "forbidden" ? 403 : 401);
      },
      verifyConfirmed,
      refreshSlots: async () => ["11:00"],
    };
    const flow = new BookingAttempt(port, () => "synthetic-key");
    const state = await flow.submit(selection);
    assert.equal(state.phase, "denied");
    if (state.phase === "denied") assert.equal(state.reason, kind);
    await flow.retry();
    assert.equal(calls, 1);
  }
});
