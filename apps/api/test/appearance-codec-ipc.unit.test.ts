import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";

import sharp from "sharp";

import { normalizeImageOverCodecIpc } from "../../../packages/appearance-asset-adapter/src/codec-ipc-client.js";
import {
  codecIpcRequest,
  IPC_MAX_IMAGE_BYTES,
} from "../../../packages/appearance-asset-adapter/src/codec-ipc-protocol.js";
import { startCodecIpcServer } from "../../../packages/appearance-asset-adapter/src/codec-ipc-server.js";
import { normalizeAppearanceImage } from "../../../packages/appearance-asset-adapter/src/codec.js";

const supported = process.platform !== "win32" && process.getuid?.() !== 0;

function fixture(t: TestContext) {
  const folder = mkdtempSync(join(tmpdir(), "kuki-codec-ipc-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const socketPath = join(folder, "codec.sock");
  const client = (timeoutMs = 3_000) => ({
    socketPath,
    expectedSocketUid: process.getuid!(),
    timeoutMs,
  });
  return { folder, socketPath, client };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function jpegFixture(): Promise<Buffer> {
  return sharp({
    create: { width: 3, height: 2, channels: 3, background: "#103050" },
  })
    .jpeg()
    .toBuffer();
}

async function awaitSignal(signal: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Codec IPC test signal did not arrive")),
          3_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  "actual Unix IPC uses a private 0660 socket and native JPEG to bounded PNG",
  { skip: !supported },
  async (t) => {
    const { socketPath, client } = fixture(t);
    const server = await startCodecIpcServer({ socketPath });
    t.after(() => close(server));
    assert.equal(statSync(socketPath).mode & 0o777, 0o660);
    const jpeg = await jpegFixture();
    const converted = await normalizeImageOverCodecIpc(
      jpeg,
      "image/jpeg",
      client(),
    );
    assert.equal(converted.width, 3);
    assert.equal(converted.height, 2);
    const meta = await sharp(converted.bytes).metadata();
    assert.equal(meta.format, "png");
    assert.equal(meta.width, 3);
    assert.equal(meta.height, 2);
    await assert.rejects(
      normalizeImageOverCodecIpc(Buffer.from("invalid"), "image/png", client()),
      /invalid-image/,
    );
    await assert.rejects(
      normalizeImageOverCodecIpc(
        Buffer.alloc(IPC_MAX_IMAGE_BYTES + 1),
        "image/png",
        client(),
      ),
      /invalid-image/,
    );
    await assert.rejects(
      normalizeImageOverCodecIpc(jpeg, "image/svg+xml", client()),
      /invalid-image/,
    );
  },
);

test(
  "codec IPC refuses concurrent requests while the native decoder is busy",
  { skip: !supported },
  async (t) => {
    const { socketPath, client } = fixture(t);
    let announce!: () => void;
    let unblock!: () => void;
    const entered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const server = await startCodecIpcServer({
      socketPath,
      normalize: async (raw, mime) => {
        announce();
        await resume;
        return normalizeAppearanceImage(raw, mime);
      },
    });
    t.after(async () => {
      unblock();
      await close(server);
    });
    const jpeg = await jpegFixture();
    const first = normalizeImageOverCodecIpc(jpeg, "image/jpeg", client());
    await awaitSignal(entered);
    await assert.rejects(
      normalizeImageOverCodecIpc(jpeg, "image/jpeg", client()),
      /codec-unavailable/,
    );
    unblock();
    assert.equal((await first).height, 2);
  },
);

test(
  "private IPC timeout fails closed and does not release admission until work finishes",
  { skip: !supported },
  async (t) => {
    const { socketPath, client } = fixture(t);
    let started!: () => void;
    let release!: () => void;
    let completed!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      completed = resolve;
    });
    let calls = 0;
    const server = await startCodecIpcServer({
      socketPath,
      normalize: async (raw, mime) => {
        calls += 1;
        if (calls === 1) {
          started();
          await resume;
          completed();
        }
        return normalizeAppearanceImage(raw, mime);
      },
    });
    t.after(async () => {
      release();
      await close(server);
    });
    const jpeg = await jpegFixture();
    const abandoned = assert.rejects(
      normalizeImageOverCodecIpc(jpeg, "image/jpeg", client(400)),
      /codec-timeout/,
    );
    await awaitSignal(entered);
    await abandoned;
    await assert.rejects(
      normalizeImageOverCodecIpc(jpeg, "image/jpeg", client()),
      /codec-unavailable/,
    );
    assert.equal(calls, 1, "denied request unexpectedly entered decoder");
    release();
    await awaitSignal(finished);
    await delay(40);
    assert.equal(
      (await normalizeImageOverCodecIpc(jpeg, "image/jpeg", client())).width,
      3,
    );
  },
);

test(
  "private IPC rejects public directories and missing endpoints without fallback",
  { skip: !supported },
  async (t) => {
    const { folder, socketPath, client } = fixture(t);
    const jpeg = await jpegFixture();
    await assert.rejects(
      normalizeImageOverCodecIpc(jpeg, "image/jpeg", client()),
      /codec-unavailable/,
    );
    chmodSync(folder, 0o777);
    await assert.rejects(
      startCodecIpcServer({ socketPath }),
      /codec-unavailable/,
    );
    chmodSync(folder, 0o700);
    const server = await startCodecIpcServer({ socketPath });
    t.after(() => close(server));
    await assert.rejects(
      startCodecIpcServer({ socketPath }),
      /codec-unavailable/,
    );
    chmodSync(folder, 0o777);
    await assert.rejects(
      normalizeImageOverCodecIpc(jpeg, "image/jpeg", client()),
      /codec-unavailable/,
    );
    chmodSync(folder, 0o700);
  },
);

test(
  "a forged malformed or oversized Unix IPC reply cannot become a trusted image",
  { skip: !supported },
  async (t) => {
    const { socketPath, client } = fixture(t);
    // This fake codec endpoint still has a correctly owned private socket;
    // a client must additionally verify version, response bounds and PNG.
    const bogus = Buffer.alloc(12);
    bogus.write("BAD1", 0);
    bogus[4] = 1;
    bogus[5] = 0;
    bogus.writeUInt32BE(0, 8);
    const server = createServer((socket) => {
      socket.end(bogus, () => socket.destroy());
    });
    const previous = process.umask(0o117);
    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    } finally {
      process.umask(previous);
    }
    t.after(() => close(server));
    await assert.rejects(
      normalizeImageOverCodecIpc(Buffer.from("bytes"), "image/png", client()),
      /codec-unavailable/,
    );
  },
);

test("IPC requests cannot smuggle file paths, MIME variants or oversized payloads", () => {
  assert.throws(
    () => codecIpcRequest(Buffer.from("valid"), "image/png; charset=utf-8"),
    /invalid-image/,
  );
  assert.throws(
    () => codecIpcRequest(Buffer.from("valid"), "constructor"),
    /invalid-image/,
  );
  assert.throws(
    () => codecIpcRequest(Buffer.alloc(0), "image/png"),
    /invalid-image/,
  );
});
