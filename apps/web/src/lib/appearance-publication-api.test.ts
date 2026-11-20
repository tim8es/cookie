import assert from "node:assert/strict";
import test from "node:test";

import {
  publishAppearanceDraft,
  readAppearancePublicationState,
  readPublishedAppearanceSnapshot,
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

test("owner published snapshot uses authenticated no-cache read", async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(
      url,
      "/v1/organizations/" + session.tenantId + "/appearance/published",
    );
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer synthetic",
    );
    return Response.json({ published });
  };
  assert.deepEqual(
    await readPublishedAppearanceSnapshot(session, fetcher),
    published,
  );
});

test("unpublished appearance is not a success receipt", async () => {
  assert.equal(
    await readPublishedAppearanceSnapshot(
      session,
      async () => new Response("", { status: 404 }),
    ),
    null,
  );
  for (const payload of [
    { draft: published },
    { published: { ...published, revision: 0 } },
    { published: { ...published, revision: 1.5 } },
    { published: { ...published, publishedAt: "invalid" } },
    { published: { ...published, config: createBrandConfig("ocean"), extra: 1 } },
    { published: { ...published, config: { ...draft.config, backgroundColor: "url(evil)" } } },
  ]) {
    await assert.rejects(
      readPublishedAppearanceSnapshot(session, async () =>
        Response.json(payload),
      ),
      /invalid-response/,
    );
  }
});

test("owner published read fails closed on revoked or unavailable authority", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests++;
    return new Response("", { status: 403 });
  };
  await assert.rejects(
    readPublishedAppearanceSnapshot(session, fetcher),
    /unauthorized/,
  );
  await assert.rejects(
    readPublishedAppearanceSnapshot(
      { ...session, expiresAtUnixSeconds: 0 },
      fetcher,
    ),
    /unauthorized/,
  );
  assert.equal(requests, 1);
  await assert.rejects(
    readPublishedAppearanceSnapshot(session, async () => {
      throw new Error("transport secret");
    }),
    /unavailable/,
  );
});

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
