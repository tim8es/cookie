import type { FastifyInstance } from "fastify";

import type { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/index.js";

/**
 * HMAC-verified, pre-linked owner/staff exchange. Explicit opt-in only.
 * The POST carries ONLY Telegram.WebApp.initData, not a client identity or
 * tenant selector. A raw Telegram ID never grants an account.
 */
export function registerTelegramAuthExchange(
  app: FastifyInstance,
  sessions: PostgresOpaqueTelegramSessions,
): void {
  app.post<{ Body: { initData: string } }>(
    "/v1/auth/telegram/exchange",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
      const body: unknown = request.body;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !("initData" in body) ||
        typeof body.initData !== "string" ||
        body.initData.length === 0 ||
        Buffer.byteLength(body.initData, "utf8") > 8192
      ) {
        return reply.code(400).send({ error: "INVALID_REQUEST" });
      }
      try {
        const issued = await sessions.exchangeTelegramInitData(body.initData);
        if (!issued) {
          return reply.code(401).send({ error: "UNAUTHENTICATED" });
        }
        // No session/tenant/role information is taken from request JSON.
        const checked = await sessions.verifyBearerToken(issued.bearerToken);
        if (!checked) {
          return reply.code(401).send({ error: "UNAUTHENTICATED" });
        }
        return reply.code(201).send({
          tokenType: "Bearer",
          accessToken: issued.bearerToken,
          tenantId: checked.tenantId,
          expiresAtUnixSeconds: issued.expiresAtUnixSeconds,
        });
      } catch {
        // Never reflect user/Telegram data, database errors or bot secrets.
        return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
      }
    },
  );

  // Bearer possession permits revocation of that exact short-lived session.
  // Authorization-header only, no cookie CSRF fallback and no tenant selector.
  app.post("/v1/auth/logout", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = request.headers.authorization;
    const token =
      typeof authorization === "string"
        ? /^Bearer (cs_[A-Za-z0-9_-]{43})$/.exec(authorization)?.[1]
        : null;
    if (!token) {
      return reply.code(401).send({ error: "UNAUTHENTICATED" });
    }
    try {
      await sessions.revokeBearerToken(token);
      return reply.code(204).send();
    } catch {
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });
}
