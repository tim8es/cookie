import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=";

async function waitForSentinel(path: string): Promise<void> {
  const end = Date.now() + 1_500;
  while (Date.now() < end) {
    if (existsSync(path)) return;
    await delay(20);
  }
  throw new Error("Codec descendant never started: no containment evidence");
}

function inGroupDescendant(
  started: string,
  escaped: string,
  writeDelayMs: number,
  parentMode: "valid" | "hang",
): string {
  // A real same-process-group grandchild ignores the supervisor's stdio and
  // writes a sentinel only if it outlives the original codec child. It exits
  // on its own after a bounded delay even if the guard regresses.
  const descendant = `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(started)}, "started");
    setTimeout(() => fs.writeFileSync(${JSON.stringify(escaped)}, "escaped"), ${writeDelayMs});
    setTimeout(() => process.exit(0), ${writeDelayMs + 500});
  `;
  const onStart =
    parentMode === "valid"
      ? `
        const png = Buffer.from(${JSON.stringify(PNG_1X1)}, "base64");
        const header = Buffer.alloc(8);
        header.writeUInt32BE(1, 0);
        header.writeUInt32BE(1, 4);
        process.stdout.write(Buffer.concat([header, png]), () => process.exit(0));
      `
      : "setInterval(() => {}, 1000);";
  return `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
      stdio: "ignore", detached: false
    });
    const poll = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(started)})) {
        clearInterval(poll);
        ${onStart}
      }
    }, 10);
    setTimeout(() => process.exit(9), 6_000).unref();
  `;
}

test(
  "POSIX codec supervisor cleans in-group descendants after a successful response",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kuki-codec-group-ok-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const started = join(dir, "started");
    const escaped = join(dir, "escaped");
    const result = await runCodecChild(
      ["-e", inGroupDescendant(started, escaped, 650, "valid")],
      Buffer.alloc(0),
      3_000,
    );
    assert.equal(existsSync(started), true, "Grandchild never started");
    assert.equal(result.width, 1);
    assert.equal(result.height, 1);
    assert.equal(result.bytes.toString("base64"), PNG_1X1);
    await delay(850);
    assert.equal(
      existsSync(escaped),
      false,
      "Grandchild escaped after success",
    );
  },
);

test(
  "POSIX codec timeout kills the whole child process group",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kuki-codec-group-timeout-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const started = join(dir, "started");
    const escaped = join(dir, "escaped");
    const running = runCodecChild(
      ["-e", inGroupDescendant(started, escaped, 2_400, "hang")],
      Buffer.alloc(0),
      1_800,
    );
    await waitForSentinel(started);
    await assert.rejects(running, /codec-timeout/);
    await delay(950);
    assert.equal(
      existsSync(escaped),
      false,
      "Grandchild escaped after timeout",
    );
  },
);
