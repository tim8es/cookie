import { lstatSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";

import { normalizeAppearanceImage } from "./codec.js";
import { AppearanceCodecFailure } from "./codec-errors.js";
import {
  codecIpcFailureResponse,
  codecIpcRequestLength,
  codecIpcSuccessResponse,
  IPC_HEADER_BYTES,
  IPC_MAX_IMAGE_BYTES,
} from "./codec-ipc-protocol.js";
import type { NormalizedAppearanceImage } from "./index.js";

export interface CodecIpcServerOptions {
  readonly socketPath: string;
  /** Isolated-worker test seam only; never selected through network input. */
  readonly normalize?: (
    bytes: Buffer,
    mime: string,
  ) => Promise<NormalizedAppearanceImage>;
  readonly deadlineMs?: number;
}

function privateDirectory(path: string): void {
  try {
    if (
      process.platform === "win32" ||
      !isAbsolute(path) ||
      path.includes("\0") ||
      Buffer.byteLength(path) > 100 ||
      !process.getuid ||
      process.getuid() === 0
    )
      throw new Error("invalid private socket placement");
    const parent = lstatSync(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid() ||
      (parent.mode & 0o027) !== 0
    )
      throw new Error("socket parent must belong to worker and be private");
  } catch {
    throw new AppearanceCodecFailure("codec-unavailable");
  }
}

function statusFor(error: unknown): Buffer {
  const code =
    error instanceof AppearanceCodecFailure ? error.code : "codec-unavailable";
  return codecIpcFailureResponse(
    code === "invalid-image" || code === "output-too-large"
      ? code
      : "codec-unavailable",
  );
}

/** Single connection, single request, no queue, and no string/error payload. */
function handleCodecConnection(
  socket: Socket,
  normalize: NonNullable<CodecIpcServerOptions["normalize"]>,
  deadlineMs: number,
  onRelease: () => void,
): void {
  let processing = false;
  let responded = false;
  let closed = false;
  let released = false;
  let expected: number | null = null;
  let mime: string | null = null;
  let total = 0;
  const chunks: Buffer[] = [];
  const release = () => {
    if (released || !closed || processing) return;
    released = true;
    onRelease();
  };
  const deadline = setTimeout(() => socket.destroy(), deadlineMs);
  function reply(frame: Buffer) {
    if (responded) return;
    responded = true;
    if (!socket.destroyed) socket.end(frame, () => socket.destroy());
  }
  socket.on("data", (part: Buffer) => {
    if (responded || processing) {
      socket.destroy(); // Reject extra bytes after the single fixed frame.
      return;
    }
    total += part.length;
    if (total > IPC_HEADER_BYTES + IPC_MAX_IMAGE_BYTES) {
      reply(codecIpcFailureResponse("invalid-image"));
      return;
    }
    chunks.push(part);
    if (expected === null && total >= IPC_HEADER_BYTES) {
      try {
        const complete = Buffer.concat(chunks, total);
        const header = codecIpcRequestLength(
          complete.subarray(0, IPC_HEADER_BYTES),
        );
        expected = header.length;
        mime = header.mime;
      } catch (error) {
        reply(statusFor(error));
        return;
      }
    }
    if (expected === null) return;
    if (total > IPC_HEADER_BYTES + expected) {
      reply(codecIpcFailureResponse("invalid-image"));
      return;
    }
    // Complete frame bytes alone do not prove a single request.
    // Hold admission and wait for the client's clean write-side EOF.
  });
  socket.on("end", () => {
    if (responded || processing) return;
    if (
      expected === null ||
      mime === null ||
      total !== IPC_HEADER_BYTES + expected
    ) {
      reply(codecIpcFailureResponse("codec-unavailable"));
      return;
    }
    const request = Buffer.concat(chunks, total);
    const raw = Buffer.from(request.subarray(IPC_HEADER_BYTES));
    processing = true;
    void (async () => {
      try {
        const image = await normalize(raw, mime);
        reply(codecIpcSuccessResponse(image));
      } catch (error) {
        reply(statusFor(error));
      } finally {
        processing = false;
        release();
      }
    })();
  });
  socket.on("error", () => {
    socket.destroy();
  });
  socket.once("close", () => {
    closed = true;
    clearTimeout(deadline);
    release();
  });
}

/**
 * Run ONLY as a non-root process inside an OS-confined image worker. The
 * operator must provision the UDS directory with 0700/0750 permissions and
 * worker ownership. No TCP/HTTP listener, DB connection, or app credentials.
 */
export async function startCodecIpcServer(
  options: CodecIpcServerOptions,
): Promise<Server> {
  const deadlineMs = options.deadlineMs ?? 12_000;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 15_000
  )
    throw new AppearanceCodecFailure("codec-unavailable");
  privateDirectory(options.socketPath);
  try {
    // A crashed worker's stale socket needs explicit operator intervention.
    // Never unlink an arbitrary preexisting filesystem object or symlink.
    lstatSync(options.socketPath);
    throw new AppearanceCodecFailure("codec-unavailable");
  } catch (error) {
    if (
      error instanceof AppearanceCodecFailure ||
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    )
      throw new AppearanceCodecFailure("codec-unavailable");
  }
  const normalize = options.normalize ?? normalizeAppearanceImage;
  let active = false;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (active) {
      // With allowHalfOpen:true, end() alone leaves an unread peer half-open.
      // Destroy after the bounded denial frame is flushed; never retain a
      // busy client's socket or block shutdown on it.
      socket.end(codecIpcFailureResponse("codec-unavailable"), () =>
        socket.destroy(),
      );
      return;
    }
    active = true;
    handleCodecConnection(socket, normalize, deadlineMs, () => {
      active = false;
    });
  });
  // POSIX socket mode is 0777 & process umask. Use 0117 -> 0660 at bind.
  // This runs in a dedicated worker, never in the application API process.
  const previousUmask = process.umask(0o117);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch {
    throw new AppearanceCodecFailure("codec-unavailable");
  } finally {
    process.umask(previousUmask);
  }
  try {
    const stat = lstatSync(options.socketPath);
    if (
      !stat.isSocket() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o660
    )
      throw new Error("private socket was not created with 0660 mode");
  } catch {
    server.close();
    throw new AppearanceCodecFailure("codec-unavailable");
  }
  return server;
}
