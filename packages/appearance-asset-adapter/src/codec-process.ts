import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { AppearanceCodecFailure } from "./codec-errors.js";
import type { AppearanceCodecFailureCode } from "./codec-errors.js";
import type { NormalizedAppearanceImage } from "./index.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT = MAX_BYTES + 8;
const MAX_AXIS = 4096;
const MAX_PIXELS = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
let busy = false;

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { UV_THREADPOOL_SIZE: "1" };
  // Windows needs its OS root. Do not inherit PATH, NODE_OPTIONS, loader
  // variables, DB URLs, bot tokens or other application secrets.
  if (process.platform === "win32" && process.env.SystemRoot)
    env.SystemRoot = process.env.SystemRoot;
  return env;
}

function decodeResponse(data: Buffer): NormalizedAppearanceImage {
  if (data.length < 41 || data.length > MAX_OUTPUT)
    throw new AppearanceCodecFailure("codec-unavailable");
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bytes = data.subarray(8);
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_AXIS ||
    height > MAX_AXIS ||
    width * height > MAX_PIXELS ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height
  ) {
    throw new AppearanceCodecFailure("codec-unavailable");
  }
  return { bytes: Buffer.from(bytes), width, height };
}

/** Internal supervisor (not exported from package entrypoint). Only trusted
 * server code supplies argv/deadline. Used by real child fault regressions.
 */
export function runCodecChild(
  argv: readonly string[],
  input: Buffer,
  deadlineMs: number,
): Promise<NormalizedAppearanceImage> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...argv], {
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    });
    let length = 0;
    const chunks: Buffer[] = [];
    let failure: AppearanceCodecFailureCode | undefined;
    const stop = (code: AppearanceCodecFailureCode) => {
      if (failure) return;
      failure = code;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("codec-timeout"), deadlineMs);
    child.on("error", () => stop("codec-unavailable"));
    child.stdin.on("error", () => stop("codec-unavailable"));
    child.stdout.on("error", () => stop("codec-unavailable"));
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      length += chunk.length;
      if (length > MAX_OUTPUT) {
        stop("codec-unavailable");
        return;
      }
      chunks.push(chunk);
    });
    // Do not release admission on timeout/signal alone. Wait until the child
    // exits and its stdio closes; a hung worker must not admit more work.
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(new AppearanceCodecFailure(failure));
      if (signal || code !== 0) {
        const reason =
          !signal && length === 0 && code === 2
            ? "invalid-image"
            : !signal && length === 0 && code === 3
              ? "output-too-large"
              : "codec-unavailable";
        return reject(new AppearanceCodecFailure(reason));
      }
      try {
        resolve(decodeResponse(Buffer.concat(chunks, length)));
      } catch {
        reject(new AppearanceCodecFailure("codec-unavailable"));
      }
    });
    child.stdin.end(input);
  });
}

/**
 * Parent process never imports sharp. A fresh OS process is used per image.
 * Timeout/byte limits and V8 heap cap do not bound native RSS or sandbox
 * privileges. The future upload surface requires deployment isolation review.
 */
export async function normalizeAppearanceImage(
  raw: Buffer,
  declaredMime: string,
): Promise<NormalizedAppearanceImage> {
  if (
    !Buffer.isBuffer(raw) ||
    raw.length === 0 ||
    raw.length > MAX_BYTES ||
    !MIME_TYPES.has(declaredMime)
  ) {
    throw new AppearanceCodecFailure("invalid-image");
  }
  if (busy) throw new AppearanceCodecFailure("codec-busy");
  busy = true;
  try {
    const sourceMode = import.meta.url.endsWith(".ts");
    const worker = fileURLToPath(
      new URL(
        sourceMode ? "./codec-worker.ts" : "./codec-worker.js",
        import.meta.url,
      ),
    );
    return await runCodecChild(
      [
        "--max-old-space-size=64",
        ...(sourceMode ? ["--import", "tsx"] : []),
        worker,
        declaredMime,
      ],
      Buffer.from(raw),
      10_000,
    );
  } finally {
    busy = false;
  }
}
