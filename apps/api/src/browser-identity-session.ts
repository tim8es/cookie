import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { IdentitySessions } from "../../../packages/platform-identity/src/index.js";

const NAME = "__Host-kuki-session";
const TOKEN = /^is_[A-Za-z0-9_-]{43}$/;

// Cookie use is restricted to this same-origin browser transport. Business APIs
// continue to authenticate exclusively via their existing Authorization header.
function sameOriginBrowser(request: FastifyRequest): boolean {
  return (
    request.headers["sec-fetch-site"] === "same-origin" &&
    request.headers["x-kuki-session"] === "1"
  );
}

function cookieToken(header: string | undefined): string | null {
  const matching = (header ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(NAME + "="));
  if (matching.length !== 1) return null;
  const token = matching[0]?.slice(NAME.length + 1) ?? "";
  return TOKEN.test(token) ? token : null;
}

function cookieHeader(token: string, age: number): string {
  return `${NAME}=${token}; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function privateResponse(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Cookie, Authorization, Sec-Fetch-Site, X-Kuki-Session");
}

export function clearMatchingBrowserSession(
  request: FastifyRequest,
  reply: FastifyReply,
  bearer: string,
): void {
  // A stale tab logging out must not erase a different account's cookie.
  if (sameOriginBrowser(request) && cookieToken(request.headers.cookie) === bearer)
    reply.header("Set-Cookie", cookieHeader("", 0));
}

export function registerBrowserIdentitySession(
  app: FastifyInstance,
  providers: readonly IdentitySessions[],
): void {
  async function resolve(token: string): Promise<number | null> {
    for (const provider of providers) {
      const session = await provider.resolveWithExpiry(token);
      if (session) {
        const expires = session.expiresAtUnixSeconds;
        const now = Math.floor(Date.now() / 1000);
        return Number.isSafeInteger(expires) &&
          expires > now &&
          expires <= now + 3600
          ? expires
          : null;
      }
    }
    return null;
  }

  // Bind only an already-issued, currently verified global Identity token.
  // The original token's DB expiry is authoritative; this is not a refresh.
  app.post("/v1/auth/browser-session", async (request, reply) => {
    privateResponse(reply);
    if (!sameOriginBrowser(request))
      return reply.code(403).send({ error: "FORBIDDEN" });
    const token = /^Bearer (is_[A-Za-z0-9_-]{43})$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!token) return reply.code(401).send({ error: "UNAUTHENTICATED" });
    try {
      const expires = await resolve(token);
      const age = expires === null ? 0 : expires - Math.floor(Date.now() / 1000);
      if (age <= 0) return reply.code(401).send({ error: "UNAUTHENTICATED" });
      reply.header("Set-Cookie", cookieHeader(token, age));
      return reply.code(204).send();
    } catch {
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });

  // Restore in the existing bearer-based UI; never use cookie claims as roles.
  app.get("/v1/auth/browser-session", async (request, reply) => {
    privateResponse(reply);
    if (!sameOriginBrowser(request))
      return reply.code(403).send({ error: "FORBIDDEN" });
    const token = cookieToken(request.headers.cookie);
    if (!token) return reply.code(401).send({ error: "UNAUTHENTICATED" });
    try {
      const expires = await resolve(token);
      if (expires === null)
        return reply.code(401).send({ error: "UNAUTHENTICATED" });
      return reply.code(200).send({
        tokenType: "Bearer",
        accessToken: token,
        scope: "identity",
        expiresAtUnixSeconds: expires,
      });
    } catch {
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });
}
