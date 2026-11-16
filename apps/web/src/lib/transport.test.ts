import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyHttpStatus,
  createJsonTransport,
  TransportFailure,
  type TransportFailureKind,
} from "./transport";

async function assertFailure(
  request: Promise<unknown>,
  kind: TransportFailureKind,
  status: number | null = null,
): Promise<void> {
  await assert.rejects(request, (value: unknown) => {
    assert.ok(value instanceof TransportFailure);
    assert.equal(value.kind, kind);
    assert.equal(value.status, status);
    return true;
  });
}

test("fetch injection does not run at construction", async () => {
  let calls = 0;
  let seenUrl: string | URL | Request | undefined;
  let seenOptions: RequestInit | undefined;
  const transport = createJsonTransport(async (url, options) => {
    calls++;
    seenUrl = url;
    seenOptions = options;
    return Response.json({ synthetic: true });
  });

  assert.equal(calls, 0);
  const url = new URL("http://127.0.0.1:1234/placeholder");
  const options: RequestInit = { method: "POST" };
  const result = await transport.request(url, options);
  assert.deepEqual(result, { synthetic: true });
  assert.equal(calls, 1);
  assert.equal(seenUrl, url);
  assert.equal(seenOptions, options);
});

test("HTTP errors remain transport failures without automatic retry", async () => {
  const cases = [
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

  for (const [status, kind] of cases) {
    let calls = 0;
    const transport = createJsonTransport(async () => {
      calls++;
      return new Response(null, { status });
    });
    assert.equal(classifyHttpStatus(status), kind);
    await assertFailure(transport.request("/placeholder"), kind, status);
    assert.equal(calls, 1);
  }
});

test("204 is empty success and malformed JSON cannot succeed", async () => {
  const empty = createJsonTransport(async () => {
    return new Response(null, { status: 204 });
  });
  assert.equal(await empty.request("/placeholder"), null);

  const invalid = createJsonTransport(async () => {
    return new Response("{", { status: 200 });
  });
  await assertFailure(invalid.request("/placeholder"), "invalid-response", 200);
});

test("network and abortion failures stay distinguishable", async () => {
  const offline = createJsonTransport(async () => {
    throw new TypeError("Synthetic network failure");
  });
  await assertFailure(offline.request("/placeholder"), "network");

  const abortController = new AbortController();
  abortController.abort();
  const cancelled = createJsonTransport(async () => {
    throw new Error("Aborted before sending");
  });
  const aborted = cancelled.request("/placeholder", {
    signal: abortController.signal,
  });
  await assertFailure(aborted, "aborted");

  const abortError = createJsonTransport(async () => {
    throw new DOMException("Cancelled", "AbortError");
  });
  await assertFailure(abortError.request("/placeholder"), "aborted");
});
