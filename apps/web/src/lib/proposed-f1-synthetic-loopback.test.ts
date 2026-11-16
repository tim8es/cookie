import assert from "node:assert/strict";
import { test } from "node:test";
import { BookingAttempt } from "./booking-attempt";
import { createCookieUiApi } from "./api";
import {
  createProposedF1SyntheticLoopbackClient,
  type ProposedF1SyntheticSelection,
} from "./proposed-f1-synthetic-loopback";
import { TransportFailure } from "./transport";

const tenantId = "10000000-1000-4000-8000-100000000001";
const customerId = "10000000-1000-4000-8000-100000000002";
const locationId = "10000000-1000-4000-8000-100000000003";
const staffId = "10000000-1000-4000-8000-100000000004";
const serviceId = "10000000-1000-4000-8000-100000000005";
const bookingId = "10000000-1000-4000-8000-100000000006";
const origin = "http://127.0.0.1:41023";
const selection: ProposedF1SyntheticSelection = {
  locationId,
  staffId,
  serviceId,
  startAt: "2027-04-12T10:00:00Z",
  localDate: "2027-04-12",
};
const slot = {
  startAt: "2027-04-12T10:00:00.000Z",
  endAt: "2027-04-12T11:00:00.000Z",
  occupiedUntil: "2027-04-12T11:15:00.000Z",
};
const confirmed = {
  bookingId,
  status: "Confirmed",
  ...slot,
  priceKopecks: "30000",
};

function harness(fetcher: typeof fetch, url = origin) {
  return createProposedF1SyntheticLoopbackClient({
    origin: url,
    tenantId,
    syntheticCustomerId: customerId,
    syntheticBearer: "synthetic-test-token",
    fetcher,
  });
}

test("loopback transport has zero I/O at construction and rejects remote targets", () => {
  let sent = 0;
  const fetcher: typeof fetch = async () => {
    sent++;
    throw new Error("Unexpected network");
  };
  harness(fetcher);
  assert.equal(sent, 0);
  for (const target of [
    "https://127.0.0.1:41023",
    "http://localhost:41023",
    "http://example.invalid:41023",
    "http://127.0.0.1:41023/api",
    "http://127.0.0.1:41023/?token=something",
    "http://user:pass@127.0.0.1:41023",
    "http://127.0.0.1",
  ]) {
    assert.throws(() => harness(fetcher, target));
  }
  assert.equal(sent, 0);
});

test("synthetic POST sends the exact proposed payload and injected test credentials", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = harness(async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Response.json(confirmed, { status: 201 });
  });

  const attempt = new BookingAttempt(client.port, () => "test-key-01");
  const state = await attempt.submit(selection);
  assert.equal(state.phase, "confirmed");
  assert.equal(
    state.phase === "confirmed" ? state.receipt.finalPriceText : "",
    "300 ₽",
  );
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    origin + "/v1/organizations/" + tenantId + "/bookings",
  );
  assert.equal(requests[0].init.method, "POST");
  const headers = new Headers(requests[0].init.headers);
  assert.equal(headers.get("Authorization"), "Bearer synthetic-test-token");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("Idempotency-Key"), "test-key-01");
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    customerId,
    locationId,
    staffId,
    serviceId,
    startAt: selection.startAt,
  });
});

test("availability is non-reserving, uses local date, and never fixes final receipt price", async () => {
  const requests: string[] = [];
  const client = harness(async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    if (url.pathname.endsWith("/availability")) {
      return Response.json({ priceKopecks: "20000", slots: [slot] });
    }
    return Response.json(confirmed, { status: 201 });
  });

  const available = await client.readAvailability(selection);
  assert.equal(available.priceKopecks, "20000");
  assert.deepEqual(available.slots, [slot]);
  assert.equal(
    requests[0],
    "/v1/organizations/" +
      tenantId +
      "/locations/" +
      locationId +
      "/availability?serviceId=" +
      serviceId +
      "&staffId=" +
      staffId +
      "&date=2027-04-12",
  );
  const state = await new BookingAttempt(
    client.port,
    () => "new-attempt",
  ).submit(selection);
  assert.equal(state.phase, "confirmed");
  assert.equal(
    state.phase === "confirmed" ? state.receipt.finalPriceText : "",
    "300 ₽",
  );
  assert.equal(requests.length, 2);
});

test("verified 409 refreshes availability; reused-key and unknown 409 do not", async () => {
  for (const code of [
    "BOOKING_CONFLICT",
    "IDEMPOTENCY_KEY_REUSED",
    "UNKNOWN_BACKEND_CODE",
  ]) {
    const requests: string[] = [];
    const client = harness(async (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (url.pathname.endsWith("/availability")) {
        return Response.json({ priceKopecks: "20000", slots: [slot] });
      }
      return Response.json({ error: { code } }, { status: 409 });
    });
    const attempt = new BookingAttempt(client.port, () => "same-test-key");
    const state = await attempt.submit(selection);
    if (code === "BOOKING_CONFLICT") {
      assert.equal(state.phase, "conflict");
      assert.deepEqual(state.phase === "conflict" ? state.slots : [], [slot]);
      assert.equal(requests.length, 2);
    } else {
      assert.deepEqual(state, {
        phase: "error",
        reason:
          code === "IDEMPOTENCY_KEY_REUSED"
            ? "idempotency-key-reused"
            : "unverified-conflict",
        retryable: false,
      });
      assert.equal(requests.length, 1);
      assert.equal(attempt.reset(), false);
    }
  }
});

test("after unknown network outcome an explicit retry uses identical key and body", async () => {
  const attempted: Array<{ key: string | null; body: string }> = [];
  const client = harness(async (_input, init) => {
    attempted.push({
      key: new Headers(init?.headers).get("Idempotency-Key"),
      body: String(init?.body),
    });
    if (attempted.length === 1) throw new TypeError("Synthetic lost reply");
    return Response.json(confirmed, { status: 201 });
  });
  const attempt = new BookingAttempt(client.port, () => "the-one-attempt-key");
  const first = await attempt.submit(selection);
  assert.deepEqual(first, {
    phase: "error",
    reason: "network",
    retryable: true,
  });
  assert.equal(attempt.reset(), false);
  const second = await attempt.retry();
  assert.equal(second.phase, "confirmed");
  assert.equal(attempted.length, 2);
  assert.deepEqual(attempted[0], attempted[1]);
});

test("authorization failures and malformed availability fail closed", async () => {
  const denied = harness(async () =>
    Response.json({ error: { code: "ACCESS_DENIED" } }, { status: 403 }),
  );
  const state = await new BookingAttempt(denied.port, () => "test-key").submit(
    selection,
  );
  assert.deepEqual(state, { phase: "denied", reason: "forbidden" });

  const malformed = harness(async () =>
    Response.json({
      priceKopecks: 15000,
      slots: [slot],
    }),
  );
  await assert.rejects(
    malformed.readAvailability(selection),
    (reason: unknown) => {
      assert.ok(reason instanceof TransportFailure);
      assert.equal(reason.kind, "invalid-response");
      return true;
    },
  );
});

test("invalid IDs, impossible times and invalid attempt keys cannot reach fetch", async () => {
  let requests = 0;
  const client = harness(async () => {
    requests++;
    return Response.json(confirmed, { status: 201 });
  });
  for (const input of [
    { ...selection, staffId: "not-a-uuid" },
    { ...selection, startAt: "2027-02-30T10:00:00Z" },
    { ...selection, startAt: "2027-04-12T10:00:01Z" },
    { ...selection, localDate: "2027-02-30" },
  ]) {
    await assert.rejects(client.readAvailability(input));
    const state = await new BookingAttempt(
      client.port,
      () => "test-key",
    ).submit(input);
    assert.deepEqual(state, {
      phase: "error",
      reason: "unexpected",
      retryable: false,
    });
  }
  const badKey = await new BookingAttempt(
    client.port,
    () => "illegal key\nInjected-Header: yes",
  ).submit(selection);
  assert.deepEqual(badKey, {
    phase: "error",
    reason: "unexpected",
    retryable: false,
  });
  assert.equal(requests, 0);
});

test("API mode is still disconnected and never switches to the synthetic harness", async () => {
  const api = createCookieUiApi("api");
  assert.equal(api.mode, "api");
  await assert.rejects(api.getSnapshot(), /API ещё не подключён/);
});
