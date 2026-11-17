import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import { normalizeAppearanceImage } from "../../../packages/appearance-asset-adapter/src/index.js";
import { runCodecChild } from "../../../packages/appearance-asset-adapter/src/codec-process.js";

test("real isolated codec normalizes and rejects invalid input", async () => {
  const jpeg = await sharp({
    create: { width: 3, height: 2, channels: 3, background: "#123456" },
  })
    .jpeg()
    .toBuffer();
  const first = normalizeAppearanceImage(jpeg, "image/jpeg");
  await assert.rejects(
    normalizeAppearanceImage(jpeg, "image/jpeg"),
    /codec-busy/,
  );
  const image = await first;
  assert.equal(image.width, 3);
  assert.equal(image.height, 2);
  assert.equal((await sharp(image.bytes).metadata()).format, "png");
  await assert.rejects(
    normalizeAppearanceImage(Buffer.from("bad"), "image/png"),
    /invalid-image/,
  );
  assert.equal((await normalizeAppearanceImage(jpeg, "image/jpeg")).height, 2);
});

test("real children time out, crash and exceed the output bound", async () => {
  for (const [code, expected] of [
    ["setInterval(()=>{},1000)", "codec-timeout"],
    ["process.exit(9)", "codec-unavailable"],
    ["process.stdout.write(Buffer.alloc(2097161))", "codec-unavailable"],
    ["process.stdout.write(Buffer.alloc(41))", "codec-unavailable"],
  ] as const) {
    await assert.rejects(
      runCodecChild(
        ["-e", code],
        Buffer.alloc(0),
        expected === "codec-timeout" ? 100 : 3000,
      ),
      new RegExp(expected),
    );
  }
});

test("codec child does not inherit application secrets or node flags", async () => {
  const key = "COOKIE_CODEC_TEST_SENTINEL";
  const before = process.env[key];
  process.env[key] = "synthetic-secret";
  try {
    // Exit 2 is decoded as invalid-image only if both variables were absent.
    await assert.rejects(
      runCodecChild(
        [
          "-e",
          "process.exit(process.env.COOKIE_CODEC_TEST_SENTINEL || process.env.NODE_OPTIONS ? 9 : 2)",
        ],
        Buffer.alloc(0),
        3000,
      ),
      /invalid-image/,
    );
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
});
