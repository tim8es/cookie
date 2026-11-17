import assert from "node:assert/strict";
import test from "node:test";

import {
  publishAppearanceDraft,
  readAppearancePublicationState,
} from "./appearance-publication-api";
import { createBrandConfig } from "./branding-config";

const session = {
  tenantId: "d58d75a2-5168-47f2-9a99-b50e79d9fdee",
  accessToken: "synthetic",
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 300,
};
const draft = { revision: 2, config: createBrandConfig("forest") };
const published = {
  ...draft,
  publishedAt: "2026-01-01T00:00:00.000Z",
};

test("publication capability distinguishes unknown", async () => {
  assert.equal(
    await readAppearancePublicationState(
      session,
      async () => new Response("", { status: 404 }),
    ),
    null,
  );
  const state = {
    draftRevision: 2,
    publishedRevision: null,
    canPublish: false,
  };
  assert.deepEqual(
    await readAppearancePublicationState(session, async () =>
      Response.json(state),
    ),
    state,
  );
  await assert.rejects(
    readAppearancePublicationState(session, async () =>
      Response.json({ ...state, publishedRevision: 3 }),
    ),
    /invalid-response/,
  );
});

test("publish uses saved revision and verifies server receipt", async () => {
  let receipt = published;
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(
      url,
      "/v1/organizations/" + session.tenantId + "/appearance/publish",
    );
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { expectedRevision: 2 });
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    return Response.json({ published: receipt });
  };
  assert.deepEqual(
    await publishAppearanceDraft(session, draft, fetcher),
    published,
  );
  receipt = { ...published, revision: 3 };
  await assert.rejects(
    publishAppearanceDraft(session, draft, fetcher),
    /invalid-response/,
  );
  receipt = { ...published, config: createBrandConfig("ocean") };
  await assert.rejects(
    publishAppearanceDraft(session, draft, fetcher),
    /invalid-response/,
  );
});

test("uncertain publish is never automatically retried", async () => {
  let count = 0;
  await assert.rejects(
    publishAppearanceDraft(session, draft, async () => {
      count++;
      throw new Error("transport failure");
    }),
    /unavailable/,
  );
  assert.equal(count, 1);
});
