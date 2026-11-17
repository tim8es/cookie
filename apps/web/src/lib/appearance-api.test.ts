import assert from "node:assert/strict";
import test from "node:test";

import {
  readRealAppearanceDraft,
  saveRealAppearanceDraft,
} from "./appearance-api";
import { createBrandConfig } from "./branding-config";

const session = {
  tenantId: "d58d75a2-5168-47f2-9a99-b50e79d9fdee",
  accessToken: "synthetic",
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 300,
};
const config = createBrandConfig("forest");

test("real appearance draft uses the verified tenant and no browser credentials", async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(
      url,
      "/v1/organizations/" + session.tenantId + "/appearance/draft",
    );
    assert.equal(init?.method, "GET");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer synthetic",
    );
    return Response.json({ draft: { revision: 0, config } });
  };
  assert.deepEqual(await readRealAppearanceDraft(session, fetcher), {
    revision: 0,
    config,
  });
});

test("save checks revision and canonical config rather than trusting HTTP 200", async () => {
  let revision = 2;
  let returned = config;
  const fetcher: typeof fetch = async (_url, init) => {
    assert.equal(init?.method, "PUT");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      expectedRevision: 1,
      config,
    });
    return Response.json({ draft: { revision, config: returned } });
  };
  assert.deepEqual(await saveRealAppearanceDraft(session, 1, config, fetcher), {
    revision: 2,
    config,
  });
  revision = 3;
  await assert.rejects(
    saveRealAppearanceDraft(session, 1, config, fetcher),
    /invalid-response/,
  );
  revision = 2;
  returned = createBrandConfig("ocean");
  await assert.rejects(
    saveRealAppearanceDraft(session, 1, config, fetcher),
    /invalid-response/,
  );
});

test("appearance conflicts and expired sessions fail closed without retries", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({ error: "stale-revision" }, { status: 409 });
  };
  await assert.rejects(
    saveRealAppearanceDraft(session, 1, config, fetcher),
    /conflict/,
  );
  await assert.rejects(
    readRealAppearanceDraft({ ...session, expiresAtUnixSeconds: 0 }, fetcher),
    /unauthorized/,
  );
  assert.equal(calls, 1);
});
