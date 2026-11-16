import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Optional same-origin compiled UI for an App Hosting deployment. Does not
 * enable API endpoints, identity, booking, payment or fake success.
 * The source directory must contain a build-produced index.html.
 */
const assetName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(?:js|css|svg|png|webp|ico|woff2?)$/i;
const mimeTypes: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function htmlResponse(reply: FastifyReply, html: Buffer): FastifyReply {
  return reply
    .header("Cache-Control", "no-store")
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY")
    .type("text/html; charset=utf-8")
    .send(html);
}

export async function registerCompiledWeb(
  app: FastifyInstance,
  directory: string,
): Promise<void> {
  const root = resolve(directory);
  // Early failure prevents an incorrectly built deployment reporting healthy.
  const indexHtml = await readFile(join(root, "index.html"));

  app.get("/", async (_request, reply) => htmlResponse(reply, indexHtml));

  app.get<{ Params: { fileName: string } }>(
    "/assets/:fileName",
    async (request, reply) => {
      const fileName = request.params.fileName;
      if (!assetName.test(fileName)) return reply.callNotFound();
      const type = mimeTypes[extname(fileName).toLowerCase()];
      if (!type) return reply.callNotFound();
      try {
        const contents = await readFile(join(root, "assets", fileName));
        return reply
          .header("Cache-Control", "public, max-age=31536000, immutable")
          .header("X-Content-Type-Options", "nosniff")
          .type(type)
          .send(contents);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        ) {
          return reply.callNotFound();
        }
        throw error;
      }
    },
  );

  app.get("/*", async (request, reply) => {
    // Explicitly refuse to turn unknown API/auth/health paths into HTML 200.
    // No dots or percent escapes: SPA routes are application paths, not files.
    const path = request.url.split("?", 1)[0] ?? "";
    if (
      !/^\/[A-Za-z0-9_/-]*$/.test(path) ||
      /^\/(?:v1|health|api|assets)(?:\/|$)/.test(path)
    ) {
      return reply.callNotFound();
    }
    return htmlResponse(reply, indexHtml);
  });
}
