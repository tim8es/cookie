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
    classifyConflict: () => "slot-unavailable" as const,
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
    classifyConflict: () => "slot-unavailable" as const,
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

test("generic HTTP 409 cannot be treated as a slot conflict", async () => {
  let refreshed = 0;
  let mutations = 0;
  const flow = new BookingAttempt(
    {
      create: async () => {
        mutations++;
        throw new TransportFailure("conflict", 409);
      },
      verifyConfirmed,
      refreshSlots: async () => {
        refreshed++;
        return ["12:00"];
      },
    },
    () => "key-for-unknown-outcome",
  );
  const state = await flow.submit(selection);
  assert.equal(state.phase, "error");
  if (state.phase === "error") {
    assert.equal(state.reason, "unverified-conflict");
    assert.equal(state.retryable, false);
  }
  assert.equal(refreshed, 0);
  assert.equal(flow.reset(), false, "unknown 409 must be reconciled first");
  await flow.retry();
  await flow.submit({ slot: "12:00" });
  assert.equal(mutations, 1, "neither retry nor new key is issued");
});

test("a verified idempotency conflict cannot refresh availability or reset", async () => {
  let refreshed = 0;
  const flow = new BookingAttempt(
    {
      create: async () => {
        throw new TransportFailure("conflict", 409);
      },
      verifyConfirmed,
      classifyConflict: () => "idempotency-key-reused" as const,
      refreshSlots: async () => {
        refreshed++;
        return ["12:00"];
      },
    },
    () => "synthetic-key",
  );
  const state = await flow.submit(selection);
  assert.equal(state.phase, "error");
  if (state.phase === "error") {
    assert.equal(state.reason, "idempotency-key-reused");
    assert.equal(state.retryable, false);
  }
  assert.equal(refreshed, 0);
  assert.equal(flow.reset(), false);
});

test("a throwing conflict validator fails closed", async () => {
  const flow = new BookingAttempt(
    {
      create: async () => {
        throw new TransportFailure("conflict", 409);
      },
      verifyConfirmed,
      classifyConflict: () => {
        throw new Error("invalid server body");
      },
      refreshSlots: async () => {
        throw new Error("should not refresh unverified conflicts");
      },
    },
    () => "synthetic-key",
  );
  const state = await flow.submit(selection);
  assert.equal(state.phase, "error");
  assert.equal(flow.reset(), false);
});

test("a later denial or slot conflict cannot resolve a lost booking response", async () => {
  for (const kind of ["unauthenticated", "forbidden", "conflict"] as const) {
    const keys: string[] = [];
    let refreshes = 0;
    const flow = new BookingAttempt(
      {
        create: async (_selection: Selection, key: string) => {
          keys.push(key);
          if (keys.length === 1) throw new TransportFailure("network");
          throw new TransportFailure(kind);
        },
        verifyConfirmed,
        classifyConflict: () => "slot-unavailable" as const,
        refreshSlots: async () => {
          refreshes++;
          return ["12:00"];
        },
      },
      () => "original-key",
    );
    await flow.submit(selection);
    assert.deepEqual(await flow.retry(), {
      phase: "error",
      reason: "outcome-unknown",
      retryable: false,
    });
    assert.equal(flow.reset(), false);
    await flow.submit({ slot: "12:00" });
    assert.deepEqual(keys, ["original-key", "original-key"]);
    assert.equal(refreshes, 0);
  }
});

test("an unclassified exception cannot authorize a new booking attempt", async () => {
  let calls = 0;
  const flow = new BookingAttempt(
    {
      create: async () => {
        calls++;
        throw new Error("Unknown failure after sending");
      },
      verifyConfirmed,
      refreshSlots: async () => [],
    },
    () => "original-key",
  );
  assert.deepEqual(await flow.submit(selection), {
    phase: "error",
    reason: "outcome-unknown",
    retryable: false,
  });
  assert.equal(flow.reset(), false);
  await flow.submit({ slot: "12:00" });
  assert.equal(calls, 1);
});
