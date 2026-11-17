import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import {
  AppearanceCodecFailure,
  normalizeAppearanceImage,
} from "../../../packages/appearance-asset-adapter/src/codec.js";

function raster() {
  return sharp({
    create: {
      width: 3,
      height: 2,
      channels: 3,
      background: "#123456",
    },
  });
}

test("real PNG JPEG WebP decode and re-encode to static PNG", async () => {
  const fixtures = [
    [await raster().png().toBuffer(), "image/png"],
    [
      await raster().jpeg().withMetadata({ orientation: 6 }).toBuffer(),
      "image/jpeg",
    ],
    [await raster().webp().toBuffer(), "image/webp"],
  ] as const;
  for (const [input, mime] of fixtures) {
    const normalized = await normalizeAppearanceImage(input, mime);
    const metadata = await sharp(normalized.bytes).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, mime === "image/jpeg" ? 2 : 3);
    assert.equal(metadata.height, mime === "image/jpeg" ? 3 : 2);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.icc, undefined);
    assert.equal(metadata.xmp, undefined);
    assert.equal(metadata.hasAlpha, true);
    assert.equal(normalized.width, metadata.width);
    assert.equal(normalized.height, metadata.height);
    const decoded = await sharp(normalized.bytes).raw().toBuffer();
    assert.equal(decoded.length, 3 * 2 * 4);
  }
});

test("invalid raster, MIME and size fail closed", async () => {
  const png = await raster().png().toBuffer();
  const excessive = await sharp({
    create: { width: 4096, height: 4096, channels: 3, background: "#000000" },
  })
    .png()
    .toBuffer();
  for (const [bytes, mime] of [
    [png, "image/jpeg"],
    [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png"],
    [png.subarray(0, 30), "image/png"],
    [Buffer.concat([png, Buffer.from("trailer")]), "image/png"],
    [Buffer.alloc(2 * 1024 * 1024 + 1), "image/png"],
    [excessive, "image/png"],
  ] as const) {
    await assert.rejects(
      normalizeAppearanceImage(bytes, mime),
      (error: unknown) =>
        error instanceof AppearanceCodecFailure &&
        error.code === "invalid-image",
    );
  }
  // A failed job must not leave the process permanently busy.
  assert.equal((await normalizeAppearanceImage(png, "image/png")).width, 3);
});

test("APNG animation and concurrent admission fail closed", async () => {
  const png = await raster().png().toBuffer();
  const animation = Buffer.alloc(20);
  animation.writeUInt32BE(8, 0);
  animation.write("acTL", 4);
  const apng = Buffer.concat([
    png.subarray(0, 33),
    animation,
    png.subarray(33),
  ]);
  await assert.rejects(
    normalizeAppearanceImage(apng, "image/png"),
    /invalid-image/,
  );
  const first = normalizeAppearanceImage(png, "image/png");
  const second = normalizeAppearanceImage(png, "image/png");
  await assert.rejects(second, /codec-busy/);
  await first;
});
