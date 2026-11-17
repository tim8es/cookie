import sharp from "sharp";

import { normalizeAppearanceImage } from "./codec.js";
import { AppearanceCodecFailure } from "./codec-errors.js";

// One isolated operation; no DB, network client, credential or original path.
const MAX_BYTES = 2 * 1024 * 1024;

async function main(): Promise<void> {
  sharp.cache(false);
  sharp.concurrency(1);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of process.stdin) {
    const chunk = Buffer.from(raw);
    length += chunk.length;
    if (length > MAX_BYTES) throw new AppearanceCodecFailure("invalid-image");
    chunks.push(chunk);
  }
  const image = await normalizeAppearanceImage(
    Buffer.concat(chunks, length),
    process.argv[2] ?? "",
  );
  const header = Buffer.alloc(8);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  // Binary protocol only; the parent accepts output after a clean process exit.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(Buffer.concat([header, image.bytes]), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

try {
  await main();
} catch (error) {
  if (error instanceof AppearanceCodecFailure) {
    process.exitCode =
      error.code === "invalid-image"
        ? 2
        : error.code === "output-too-large"
          ? 3
          : 4;
  } else {
    process.exitCode = 4;
  }
}
