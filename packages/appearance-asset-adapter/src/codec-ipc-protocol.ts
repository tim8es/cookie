import { AppearanceCodecFailure } from "./codec-errors.js";
import type { NormalizedAppearanceImage } from "./index.js";

/**
 * Private binary codec IPC v1, exclusively over an operator-provisioned UDS.
 * The protocol deliberately carries no tenant ID, token, file path or URL.
 * All byte counts are fixed-size and checked BEFORE allocating a frame.
 */
export const IPC_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const IPC_HEADER_BYTES = 12;
export const IPC_MAX_FRAME_BYTES = IPC_MAX_IMAGE_BYTES + IPC_HEADER_BYTES + 8;
const REQUEST_MAGIC = Buffer.from("KCI1");
const RESPONSE_MAGIC = Buffer.from("KCO1");
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

export type CodecMime = "image/png" | "image/jpeg" | "image/webp";
export const IPC_STATUS = {
  ok: 0,
  invalid: 1,
  tooLarge: 2,
  unavailable: 3,
} as const;

const MIME_TO_ID: Readonly<Record<CodecMime, number>> = {
  "image/png": 1,
  "image/jpeg": 2,
  "image/webp": 3,
};
const ID_TO_MIME: Readonly<Record<number, CodecMime>> = {
  1: "image/png",
  2: "image/jpeg",
  3: "image/webp",
};

function unavailable(): never {
  throw new AppearanceCodecFailure("codec-unavailable");
}

export function codecIpcRequest(raw: Buffer, mime: string): Buffer {
  if (
    !Buffer.isBuffer(raw) ||
    raw.length < 1 ||
    raw.length > IPC_MAX_IMAGE_BYTES ||
    !Object.hasOwn(MIME_TO_ID, mime)
  )
    throw new AppearanceCodecFailure("invalid-image");
  const header = Buffer.alloc(IPC_HEADER_BYTES);
  REQUEST_MAGIC.copy(header);
  header[4] = 1;
  header[5] = MIME_TO_ID[mime as CodecMime];
  header.writeUInt32BE(raw.length, 8);
  return Buffer.concat([header, raw], header.length + raw.length);
}

export function codecIpcRequestLength(header: Buffer): {
  readonly length: number;
  readonly mime: CodecMime;
} {
  if (
    header.length !== IPC_HEADER_BYTES ||
    !header.subarray(0, 4).equals(REQUEST_MAGIC) ||
    header[4] !== 1 ||
    header[6] !== 0 ||
    header[7] !== 0
  )
    return unavailable();
  const mime = ID_TO_MIME[header[5]!];
  const length = header.readUInt32BE(8);
  if (!mime || length < 1 || length > IPC_MAX_IMAGE_BYTES)
    throw new AppearanceCodecFailure("invalid-image");
  return { length, mime };
}

function ipcResponse(status: number, body: Buffer): Buffer {
  const header = Buffer.alloc(IPC_HEADER_BYTES);
  RESPONSE_MAGIC.copy(header);
  header[4] = 1;
  header[5] = status;
  header.writeUInt32BE(body.length, 8);
  return Buffer.concat([header, body], IPC_HEADER_BYTES + body.length);
}

export function codecIpcFailureResponse(
  code: "invalid-image" | "output-too-large" | "codec-unavailable",
): Buffer {
  const status =
    code === "invalid-image"
      ? IPC_STATUS.invalid
      : code === "output-too-large"
        ? IPC_STATUS.tooLarge
        : IPC_STATUS.unavailable;
  return ipcResponse(status, Buffer.alloc(0));
}

function verifyImageBody(body: Buffer): NormalizedAppearanceImage {
  if (body.length < 41 || body.length > IPC_MAX_IMAGE_BYTES + 8)
    return unavailable();
  const width = body.readUInt32BE(0);
  const height = body.readUInt32BE(4);
  const bytes = body.subarray(8);
  if (
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    width * height > 4 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height
  )
    return unavailable();
  return { bytes: Buffer.from(bytes), width, height };
}

export function codecIpcSuccessResponse(
  image: NormalizedAppearanceImage,
): Buffer {
  if (
    !Buffer.isBuffer(image.bytes) ||
    image.bytes.length < 33 ||
    image.bytes.length > IPC_MAX_IMAGE_BYTES
  )
    return unavailable();
  const body = Buffer.alloc(8 + image.bytes.length);
  body.writeUInt32BE(image.width, 0);
  body.writeUInt32BE(image.height, 4);
  image.bytes.copy(body, 8);
  verifyImageBody(body);
  return ipcResponse(IPC_STATUS.ok, body);
}

export function codecIpcResponseLength(header: Buffer): number {
  if (
    header.length !== IPC_HEADER_BYTES ||
    !header.subarray(0, 4).equals(RESPONSE_MAGIC) ||
    header[4] !== 1 ||
    header[6] !== 0 ||
    header[7] !== 0
  )
    return unavailable();
  const status = header[5];
  const length = header.readUInt32BE(8);
  if (
    !Object.values(IPC_STATUS).includes(status as 0 | 1 | 2 | 3) ||
    length > IPC_MAX_IMAGE_BYTES + 8 ||
    (status === IPC_STATUS.ok && length < 41) ||
    (status !== IPC_STATUS.ok && length !== 0)
  )
    return unavailable();
  return length;
}

export function codecIpcReadResponse(frame: Buffer): NormalizedAppearanceImage {
  if (frame.length < IPC_HEADER_BYTES) return unavailable();
  const length = codecIpcResponseLength(frame.subarray(0, IPC_HEADER_BYTES));
  if (frame.length !== IPC_HEADER_BYTES + length) return unavailable();
  switch (frame[5]) {
    case IPC_STATUS.invalid:
      throw new AppearanceCodecFailure("invalid-image");
    case IPC_STATUS.tooLarge:
      throw new AppearanceCodecFailure("output-too-large");
    case IPC_STATUS.unavailable:
      return unavailable();
    case IPC_STATUS.ok:
      return verifyImageBody(frame.subarray(IPC_HEADER_BYTES));
    default:
      return unavailable();
  }
}
