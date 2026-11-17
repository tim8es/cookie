import assert from "node:assert/strict";
import test from "node:test";

import {
  OwnerAuthFailure,
  authenticateTelegramOwner,
  loadTelegramInitData,
  readTelegramInitData,
  revokeTelegramOwnerSession,
  telegramLoginAvailable,
} from "./owner-auth";

const TENANT = "11111111-1111-4111-8111-111111111111";
const TOKEN = "cs_" + "A".repeat(43);
const NOW = 1_800_000_000;

test("available methods are read from the server and malformed responses fail closed", async () => {
  const fetchJson = (value: unknown) =>
    (async () => new Response(JSON.stringify(value))) as typeof fetch;
  assert.equal(await telegramLoginAvailable(fetchJson({ methods: [] })), false);
  assert.equal(
    await telegramLoginAvailable(fetchJson({ methods: ["telegram"] })),
    true,
  );
  assert.equal(
    await telegramLoginAvailable(fetchJson({ methods: ["future"] })),
    false,
  );
  await assert.rejects(
    telegramLoginAvailable(fetchJson({ methods: ["telegram", 1] })),
    OwnerAuthFailure,
  );
  await assert.rejects(
    telegramLoginAvailable((async () => {
      throw new Error("offline");
    }) as typeof fetch),
    OwnerAuthFailure,
  );
});

function receipt(overrides: Record<string, unknown> = {}): unknown {
  return {
    tokenType: "Bearer",
    accessToken: TOKEN,
    tenantId: TENANT,
    expiresAtUnixSeconds: NOW + 900,
    ...overrides,
  };
}

function responder(
  responses: Array<() => Response>,
  seen: Array<{ url: string; init: RequestInit }>,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected network request");
    return next();
  }) as typeof fetch;
}

async function assertAuthFailure(
  task: Promise<unknown>,
  reason: OwnerAuthFailure["reason"],
): Promise<void> {
  await assert.rejects(task, (value: unknown) => {
    assert.ok(value instanceof OwnerAuthFailure);
    assert.equal(value.reason, reason);
    assert.doesNotMatch(value.message, /cs_|initData|secret/i);
    return true;
  });
}

test("proof comes only from Mini App JS, never URL or demo", () => {
  assert.equal(readTelegramInitData(undefined), null);
  const spoofed = {
    location: { search: "?initData=forged" },
  } as unknown as Window;
  const empty = { Telegram: { WebApp: { initData: "" } } } as unknown as Window;
  const valid = {
    Telegram: { WebApp: { initData: "signed-proof" } },
  } as unknown as Window;
  assert.equal(readTelegramInitData(spoofed), null);
  assert.equal(readTelegramInitData(empty), null);
  assert.equal(readTelegramInitData(valid), "signed-proof");
});

test("Telegram SDK is loaded only when proof is not yet present", async () => {
  const injected = {
    Telegram: { WebApp: { initData: "" } },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  };
  let loaded = "";
  const doc = {
    createElement: () => ({
      src: "",
      async: false,
      referrerPolicy: "",
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
    }),
    head: {
      append: (script: {
        src: string;
        async: boolean;
        referrerPolicy: string;
        onload: (() => void) | null;
      }) => {
        loaded = script.src;
        assert.equal(script.async, true);
        assert.equal(script.referrerPolicy, "no-referrer");
        injected.Telegram.WebApp.initData = "new-signed-proof";
        script.onload?.();
      },
    },
  };
  assert.equal(
    await loadTelegramInitData(
      injected as unknown as Window,
      doc as unknown as Document,
    ),
    "new-signed-proof",
  );
  assert.equal(loaded, "https://telegram.org/js/telegram-web-app.js");
  loaded = "";
  assert.equal(
    await loadTelegramInitData(
      injected as unknown as Window,
      doc as unknown as Document,
    ),
    "new-signed-proof",
  );
  assert.equal(loaded, "");
});

test("proof exchange must match protected context", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = responder(
    [
      () => Response.json(receipt(), { status: 201 }),
      () => Response.json({ tenantId: TENANT }),
    ],
    calls,
  );
  const result = await authenticateTelegramOwner("signed-proof", fetcher, NOW);
  assert.equal(result.tenantId, TENANT);
  assert.equal(result.accessToken, TOKEN);
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      "/v1/auth/telegram/exchange",
      "/v1/organizations/" + TENANT + "/session-context",
    ],
  );
  for (const { init } of calls) {
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.equal(init.referrerPolicy, "no-referrer");
  }
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    initData: "signed-proof",
  });
  assert.equal(
    (calls[1]?.init.headers as Record<string, string>).authorization,
    "Bearer " + TOKEN,
  );
  assert.equal(JSON.stringify(result).includes("signed-proof"), false);
});

test("no proof and oversized proof fail without issuing requests", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = responder([], calls);
  await assertAuthFailure(
    authenticateTelegramOwner("", fetcher, NOW),
    "unauthorized",
  );
  await assertAuthFailure(
    authenticateTelegramOwner("a".repeat(8193), fetcher, NOW),
    "unauthorized",
  );
  assert.equal(calls.length, 0);
});

test("invalid response fields reject without requesting context", async () => {
  const invalid = [
    receipt({ accessToken: "test-token" }),
    receipt({ tenantId: "invalid" }),
    receipt({ expiresAtUnixSeconds: NOW - 1 }),
    receipt({ expiresAtUnixSeconds: NOW + 7200 }),
    receipt({ tokenType: "Cookie" }),
    null,
    { success: true },
  ];
  for (const body of invalid) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await assertAuthFailure(
      authenticateTelegramOwner(
        "proof",
        responder([() => Response.json(body, { status: 201 })], calls),
        NOW,
      ),
      "invalid-response",
    );
    assert.equal(calls.length, 1);
  }
});

test("401 exchange and disabled endpoint do not obtain session", async () => {
  for (const [status, reason] of [
    [401, "unauthorized"],
    [404, "unavailable"],
    [503, "unavailable"],
  ] as const) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await assertAuthFailure(
      authenticateTelegramOwner(
        "proof",
        responder([() => new Response(null, { status })], calls),
        NOW,
      ),
      reason,
    );
    assert.equal(calls.length, 1);
  }
});

test("context mismatch triggers logout and fails closed", async () => {
  for (const [response, reason] of [
    [() => Response.json({ tenantId: "wrong-tenant" }), "invalid-response"],
    [() => new Response(null, { status: 403 }), "unauthorized"],
    [() => new Response(null, { status: 503 }), "unavailable"],
  ] as const) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await assertAuthFailure(
      authenticateTelegramOwner(
        "proof",
        responder(
          [
            () => Response.json(receipt(), { status: 201 }),
            response,
            () => new Response(null, { status: 204 }),
          ],
          calls,
        ),
        NOW,
      ),
      reason,
    );
    assert.equal(calls[2]?.url, "/v1/auth/logout");
  }
});

test("failed request and logout response never claim success", async () => {
  const offline = (async () => {
    throw new Error("secret internal network path");
  }) as typeof fetch;
  await assertAuthFailure(
    authenticateTelegramOwner("proof", offline, NOW),
    "unavailable",
  );
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const session = receipt() as {
    accessToken: string;
    tenantId: string;
    expiresAtUnixSeconds: number;
  };
  await assertAuthFailure(
    revokeTelegramOwnerSession(
      session,
      responder([() => new Response(null, { status: 503 })], calls),
    ),
    "unavailable",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/v1/auth/logout");
});
