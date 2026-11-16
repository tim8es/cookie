import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyHttpStatus,
  createJsonTransport,
  TransportFailure,
} from "./transport";

function responseFetcher(response: Response) {
  let calls = 0;
  const transport = createJsonTransport(async () => {
    calls++;
    return response;
  });
  return {
    transport,
    get calls() {
      return calls;
    },
  };
}

function expectedFailure(kind: string, status: number | null = null) {
  return (reason: unknown): boolean =>
    reason instanceof TransportFailure &&
    reason.kind === kind &&
    reason.status === status;
}

test("HTTP transport starts offline and preserves caller inputs", async () => {
  let observedUrl: string | URL | undefined;
  let observedInit: RequestInit | undefined;
  let calls = 0;
  const transport = createJsonTransport(async (url, init) => {
    calls++;
    observedUrl = url;
    observedInit = init;
    return Response.json({ synthetic: "ok" });
  });
  assert.equal(calls, 0);
  const url = new URL("http://127.0.0.1:1234/contract-to-be-reviewed");
  const controller = new AbortController();
  const init: RequestInit = {
    method: "POST",
    body: JSON.stringify({ synthetic: true }),
    signal: controller.signal,
  };
  assert.deepEqual(await transport.request(url, init), { synthetic: "ok" });
  assert.equal(calls, 1);
  assert.equal(observedUrl, url);
  assert.equal(observedInit, init);
});

test("HTTP statuses map to generic transport errors", async () => {
  const statuses = [
    [400, "http"],
    [401, "unauthenticated"],
    [403, "forbidden"],
    [404, "not-found"],
    [409, "conflict"],
    [422, "http"],
    [429, "rate-limited"],
    [500, "server"],
    [503, "server"],
  ] as const;
  for (const [status, kind] of statuses) {
    assert.equal(classifyHttpStatus(status), kind);
    const fixture = responseFetcher(
      Response.json({ synthetic: "ignored" }, { status }),
    );
    await assert.rejects(
      () => fixture.transport.request("/contract-not-defined"),
      expectedFailure(kind, status),
    );
    assert.equal(fixture.calls, 1, "never auto-retry a mutation");
  }
});

test("204 returns null and malformed JSON is not success", async () => {
  const empty = responseFetcher(new Response(null, { status: 204 }));
  assert.equal(await empty.transport.request("/reviewed-only"), null);

  const bad = responseFetcher(new Response("invalid json", { status: 200 }));
  await assert.rejects(
    () => bad.transport.request("/reviewed-only"),
    expectedFailure("invalid-response", 200),
  );
});

test("offline and aborted requests never report success", async () => {
  let calls = 0;
  const offline = createJsonTransport(async () => {
    calls++;
    throw new TypeError("Simulated offline");
  });
  await assert.rejects(
    () => offline.request("/none"),
    expectedFailure("network"),
  );
  assert.equal(calls, 1);

  const controller = new AbortController();
  controller.abort();
  const cancelled = createJsonTransport(async () => {
    throw new Error("fetch rejected after abort");
  });
  await assert.rejects(
    () => cancelled.request("/none", { signal: controller.signal }),
    expectedFailure("aborted"),
  );

  const abortError = createJsonTransport(async () => {
    throw new DOMException("Aborted", "AbortError");
  });
  await assert.rejects(
    () => abortError.request("/none"),
    expectedFailure("aborted"),
  );
});

test("a 409 never turns into a booking confirmation", async () => {
  const failedBooking = responseFetcher(new Response(null, { status: 409 }));
  await assert.rejects(
    () => failedBooking.transport.request("/not-an-endpoint", {
      method: "POST",
    }),
    expectedFailure("conflict", 409),
  );
  assert.equal(failedBooking.calls, 1);
});
