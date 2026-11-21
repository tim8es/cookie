import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute } from "node:path";

import { AppearanceCodecFailure } from "./codec-errors.js";
import {
  codecIpcReadResponse,
  codecIpcRequest,
  codecIpcResponseLength,
  IPC_HEADER_BYTES,
  IPC_MAX_FRAME_BYTES,
} from "./codec-ipc-protocol.js";
import type { NormalizedAppearanceImage } from "./index.js";

export interface CodecIpcClientOptions {
  readonly socketPath: string;
  /** Reviewed service UID supplied by the operator, never a request header. */
  readonly expectedSocketUid: number;
  /** Private transport deadline, NOT an HTTP/client configurable policy. */
  readonly timeoutMs?: number;
}

/** The private socket is not allowed in /tmp or world-writable directories. */
export function requirePrivateCodecSocket(
  socketPath: string,
  expectedSocketUid: number,
): void {
  try {
    if (
      process.platform === "win32" ||
      !isAbsolute(socketPath) ||
      socketPath.includes("\0") ||
      Buffer.byteLength(socketPath) > 100 ||
      !Number.isSafeInteger(expectedSocketUid) ||
      expectedSocketUid < 1
    )
      throw new Error("invalid private socket path or owner");
    const parent = lstatSync(dirname(socketPath));
    const socket = lstatSync(socketPath);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.mode & 0o027) !== 0 ||
      !socket.isSocket() ||
      socket.isSymbolicLink() ||
      socket.uid !== expectedSocketUid ||
      socket.gid !== parent.gid ||
      (socket.mode & 0o117) !== 0
    )
      throw new Error("private socket permissions invalid");
  } catch {
    throw new AppearanceCodecFailure("codec-unavailable");
  }
}

/**
 * No fallback to local sharp or unrestricted subprocess if the isolated
 * endpoint is absent/malformed/slow. No tenant IDs, authorization headers,
 * credentials or filesystem names are transmitted in the binary request.
 */
export async function normalizeImageOverCodecIpc(
  raw: Buffer,
  declaredMime: string,
  options: CodecIpcClientOptions,
): Promise<NormalizedAppearanceImage> {
  const request = codecIpcRequest(raw, declaredMime);
  const timeout = options.timeoutMs ?? 12_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15_000)
    throw new AppearanceCodecFailure("codec-unavailable");
  requirePrivateCodecSocket(options.socketPath, options.expectedSocketUid);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: options.socketPath });
    let total = 0;
    let expected: number | null = null;
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error: unknown, result?: NormalizedAppearanceImage) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new AppearanceCodecFailure("codec-unavailable"));
    };
    const deadline = setTimeout(
      () => finish(new AppearanceCodecFailure("codec-timeout")),
      timeout,
    );
    socket.on("connect", () => {
      socket.write(request);
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > IPC_MAX_FRAME_BYTES) {
        finish(new AppearanceCodecFailure("codec-unavailable"));
        return;
      }
      chunks.push(chunk);
      if (expected === null && total >= IPC_HEADER_BYTES) {
        try {
          expected = codecIpcResponseLength(
            Buffer.concat(chunks, total).subarray(0, IPC_HEADER_BYTES),
          );
        } catch {
          finish(new AppearanceCodecFailure("codec-unavailable"));
          return;
        }
      }
      if (expected === null) return;
      if (total > IPC_HEADER_BYTES + expected) {
        finish(new AppearanceCodecFailure("codec-unavailable"));
        return;
      }
      if (total === IPC_HEADER_BYTES + expected) {
        try {
          finish(null, codecIpcReadResponse(Buffer.concat(chunks, total)));
        } catch (error) {
          finish(error);
        }
      }
    });
    socket.on("error", () => {
      finish(new AppearanceCodecFailure("codec-unavailable"));
    });
    socket.on("end", () => {
      finish(new AppearanceCodecFailure("codec-unavailable"));
    });
    socket.on("close", () => {
      finish(new AppearanceCodecFailure("codec-unavailable"));
    });
  });
}
