import assert from "node:assert/strict";
import test from "node:test";

import {
  readAppearanceAssetCapability,
  readAppearanceAssetPreview,
  uploadAppearanceAsset,
} from "./appearance-assets-api";

const id = "d58d75a2-5168-47f2-9a99-b50e79d9fdee";
const session = {
  tenantId: id,
  accessToken: "synthetic",
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 300,
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
  "base64",
);

test("private asset capability is fail closed", async () => {
  assert.equal(
    await readAppearanceAssetCapability(session, async () => new Response("", { status: 404 })),
    false,
  );
  assert.equal(
    await readAppearanceAssetCapability(session, async () => Response.json({ enabled: true })),
    true,
  );
  await assert.rejects(
    readAppearanceAssetCapability(session, async () => Response.json({ enabled: "true" })),
    /invalid-response/,
  );
});

test("asset upload verifies receipt and preview uses bearer without a URL token", async () => {
  const raw = new Blob([png], { type: "image/png" });
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    if (init?.method === "POST") {
      assert.equal(url, "/v1/organizations/" + id + "/appearance/assets/logo");
      assert.equal(init.body, raw);
      return Response.json({ asset: { id, kind: "logo", mime: "image/png", width: 1, height: 1 } });
    }
    assert.equal(url, "/v1/organizations/" + id + "/appearance/assets/logo/" + id);
    return new Response(png, { headers: { "content-type": "image/png" } });
  };
  const asset = await uploadAppearanceAsset(session, "logo", raw, fetcher);
  const preview = await readAppearanceAssetPreview(session, "logo", asset.id, fetcher, undefined, asset);
  assert.equal(preview.size, png.length);
  assert.equal(preview.type, "image/png");
});

test("wrong receipt kind and untrusted preview are rejected", async () => {
  await assert.rejects(
    uploadAppearanceAsset(session, "logo", new Blob([png], { type: "image/png" }), async () =>
      Response.json({ asset: { id, kind: "background", mime: "image/png", width: 1, height: 1 } }),
    ),
    /invalid-response/,
  );
  for (const payload of [Buffer.from("not an image"), Buffer.alloc(2 * 1024 * 1024 + 1)]) {
    await assert.rejects(
      readAppearanceAssetPreview(session, "logo", id, async () =>
        new Response(payload, { headers: { "content-type": "image/png" } }),
      ),
      /invalid-response/,
    );
  }
});
