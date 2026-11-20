import assert from "node:assert/strict";
import test from "node:test";
import { CandidateRefreshBrowser } from "./synthetic-refresh-browser.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function fixture() {
  const stored = new Map<string, string>();
  const calls: {
    action: string;
    family: string | null;
    access: string | null;
  }[] = [];
  let queue = Promise.resolve();
  let family = A;
  let now = 1000;
  let fail = false;
  let sequence = 0;
  let active = 0;
  let maxActive = 0;
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const fetcher: typeof fetch = async (url, init) => {
    const action = String(url).split("/").at(-1)!;
    const headers = new Headers(init?.headers);
    const expected = headers.get("x-kuki-family");
    calls.push({
      action,
      family: expected,
      access: headers.get("authorization"),
    });
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.cache, "no-store");
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await Promise.resolve();
      if (fail) throw new Error("lost response");
      if (action !== "login" && expected !== family)
        return new Response(null, { status: 401 });
      if (action === "logout") return new Response(null, { status: 204 });
      return Response.json({
        scope: "identity",
        tokenType: "Bearer",
        familyId: family,
        accessToken: "is_" + String(++sequence).padStart(43, "A"),
        expiresAtUnixSeconds: now + 60,
      });
    } finally {
      active--;
    }
  };
  return {
    create: () =>
      new CandidateRefreshBrowser({
        exclusive,
        storage: {
          getItem: (key) => stored.get(key) ?? null,
          setItem: (key, value) => void stored.set(key, value),
        },
        fetcher,
        nowSeconds: () => now,
      }),
    calls,
    stored,
    setFamily: (next: string) => (family = next),
    setNow: (next: number) => (now = next),
    loseResponse: () => (fail = true),
    maxActive: () => maxActive,
  };
}

test("candidate serializes mutations, restores same family, and rejects stale tab after new login", async () => {
  const f = fixture();
  const first = f.create();
  const second = f.create();
  const login = await first.login("signed proof");
  assert.ok(login);
  await second.restore();
  f.setNow(1055);
  const renewed = await Promise.all([
    first.renewIfNeeded(10),
    first.renewIfNeeded(10),
    second.renewIfNeeded(10),
  ]);
  assert.ok(renewed.every((result) => result?.familyId === A));
  assert.equal(f.maxActive(), 1);
  assert.equal(f.calls.filter((call) => call.action === "rotate").length, 3);
  f.setFamily(B);
  assert.equal((await second.login("different signed proof"))?.familyId, B);
  assert.equal(first.current(), null);
  const before = f.calls.length;
  assert.equal(await first.logout(), false);
  assert.equal(await first.restore(), null);
  assert.equal(f.calls.length, before);
  assert.equal((await f.create().restore())?.familyId, B);
  assert.deepEqual([...f.stored.values()], [B]);
});

test("ambiguous rotation fences every tab and reload without replay", async () => {
  const f = fixture();
  const first = f.create();
  const second = f.create();
  await first.login("signed proof");
  await second.restore();
  f.setNow(1059);
  f.loseResponse();
  assert.equal(await first.renewIfNeeded(10), null);
  assert.equal(second.current(), null);
  assert.equal(await second.renewIfNeeded(10), null);
  assert.equal(await f.create().restore(), null);
  assert.equal(f.calls.length, 3);
  assert.deepEqual([...f.stored.values()], ["blocked"]);
});

test("late cookie from old family cannot be adopted on reload", async () => {
  const f = fixture();
  await f.create().login("signed proof");
  f.setFamily(B);
  assert.equal(await f.create().restore(), null);
  assert.equal(f.calls.at(-1)?.family, A);
  assert.deepEqual([...f.stored.values()], ["blocked"]);
});

test("crashed rotation leaves all tabs fenced until a confirmed response", async () => {
  const f = fixture();
  const first = f.create();
  const second = f.create();
  await first.login("signed proof");
  await second.restore();
  assert.equal(second.current()?.familyId, A);

  // Simulate crash after the durable write, before a response is accepted.
  const key = [...f.stored.keys()][0]!;
  f.stored.set(key, "pending:" + A);
  const before = f.calls.length;
  assert.equal(first.current(), null);
  assert.equal(second.current(), null);
  assert.equal(await f.create().restore(), null);
  assert.equal(await first.renewIfNeeded(10), null);
  assert.equal(f.calls.length, before);
  assert.deepEqual([...f.stored.values()], ["pending:" + A]);

  // Only an explicit fresh login may clear a stranded pending fence.
  f.setFamily(B);
  assert.equal((await second.login("fresh signed proof"))?.familyId, B);
  assert.equal(first.current(), null);
});
