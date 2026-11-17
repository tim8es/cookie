import sharp from "sharp";

import { AppearanceCodecFailure } from "./codec-errors.js";
export { AppearanceCodecFailure } from "./codec-errors.js";

import type { NormalizedAppearanceImage } from "./index.js";

// Engineering resource bounds, not salon-specific commercial policy.
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AXIS = 4096;
const MAX_PIXELS = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

type Format = "png" | "jpeg" | "webp";
function invalid(): never {
  throw new AppearanceCodecFailure("invalid-image");
}

/** Allow only the three intended raster loaders, never SVG or remote paths. */
function formatOf(bytes: Buffer, mime: string): Format {
  if (mime === "image/png" && bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    return "png";
  if (
    mime === "image/jpeg" &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "jpeg";
  if (
    mime === "image/webp" &&
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  return invalid();
}

/** Some PNG loaders ignore APNG animation. Reject animation chunks before
 * native decode, along with malformed lengths or bytes after IEND.
 * libvips still owns all pixel decoding/CRC and actual image validation.
 */
function requireStaticPng(bytes: Buffer): void {
  let cursor = 8;
  while (cursor + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(cursor);
    const next = cursor + 12 + length;
    if (next > bytes.length) invalid();
    const type = bytes.toString("ascii", cursor + 4, cursor + 8);
    if (type === "acTL" || type === "fcTL" || type === "fdAT") invalid();
    if (type === "IEND") {
      if (length !== 0 || next !== bytes.length) invalid();
      return;
    }
    cursor = next;
  }
  invalid();
}

function requireStaticWebp(bytes: Buffer): void {
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
  let cursor = 12;
  while (cursor + 8 <= bytes.length) {
    const kind = bytes.toString("ascii", cursor, cursor + 4);
    const length = bytes.readUInt32LE(cursor + 4);
    const next = cursor + 8 + length + (length % 2);
    if (next > bytes.length) invalid();
    if (kind === "ANIM" || kind === "ANMF") invalid();
    if (kind === "VP8X") {
      if (length !== 10 || (bytes[cursor + 8]! & 0x02) !== 0) invalid();
    }
    cursor = next;
  }
  if (cursor !== bytes.length) invalid();
}

function validDimensions(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= MAX_AXIS &&
    height <= MAX_AXIS &&
    width * height <= MAX_PIXELS
  );
}

// No unbounded codec queue. The eventual HTTP layer must authorize and apply
// per-tenant request/storage bounds before admitting work.
let busy = false;

/**
 * Decode actual raster pixels and emit a new static sRGB PNG, never original
 * bytes or input metadata. Server-only; no upload route is mounted here.
 * Native codec timeout is not a hard process/RSS sandbox: that gate remains.
 */
export async function normalizeAppearanceImage(
  raw: Buffer,
  declaredMime: string,
): Promise<NormalizedAppearanceImage> {
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > MAX_BYTES)
    invalid();
  if (busy) throw new AppearanceCodecFailure("codec-busy");
  busy = true;
  try {
    const bytes = Buffer.from(raw);
    const format = formatOf(bytes, declaredMime);
    if (format === "png") requireStaticPng(bytes);
    if (format === "webp") requireStaticWebp(bytes);
    const decoder = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: MAX_PIXELS,
      sequentialRead: true,
      animated: false,
    }).timeout({ seconds: 5 });
    const meta = await decoder.metadata();
    if (
      meta.format !== format ||
      (meta.pages ?? 1) !== 1 ||
      !validDimensions(meta.width, meta.height)
    )
      invalid();
    const { data, info } = await decoder
      .autoOrient()
      .toColourspace("srgb")
      .ensureAlpha()
      .png({ compressionLevel: 6, palette: false, progressive: false })
      .toBuffer({ resolveWithObject: true });
    if (data.length > MAX_BYTES)
      throw new AppearanceCodecFailure("output-too-large");
    if (
      info.format !== "png" ||
      !validDimensions(info.width, info.height) ||
      !data.subarray(0, 8).equals(PNG_SIGNATURE)
    )
      invalid();
    return { bytes: data, width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof AppearanceCodecFailure) throw error;
    // Never disclose native decoder messages, filenames or user metadata.
    return invalid();
  } finally {
    busy = false;
  }
}
