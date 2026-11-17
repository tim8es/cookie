import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { runSqlTransaction } from "../../../packages/platform-db/src/transaction.js";
import type { TelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import { IdentitySessions } from "../../../packages/platform-identity/src/identity-sessions.js";
import { exchangeSelfServiceTelegram } from "../../../packages/platform-identity/src/telegram-self-registration.js";
import type { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";

export interface TelegramIdentityAuthDependencies {
  readonly pool: Pool;
  readonly verifier: TelegramMiniAppProofVerifier;
  readonly fingerprintSecret: Buffer;
  readonly identitySessions: IdentitySessions;
  /** Compatibility bridge for previously operator-linked tenant owners. */
  readonly legacySessions?: PostgresOpaqueTelegramSessions;
  readonly ttlSeconds: number;
}

/** Verified provider login/registration only; no tenant or business role is granted. */
export function registerTelegramIdentityAuth(
  app: FastifyInstance,
  dependencies: TelegramIdentityAuthDependencies,
): void {
  app.post<{ Body: { initData: string; intent: "login" | "register" } }>(
    "/v1/auth/telegram/identity",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
      const body: unknown = request.body;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        !("initData" in body) ||
        typeof body.initData !== "string" ||
        !("intent" in body) ||
        !["login", "register"].includes(String(body.intent))
      )
        return reply.code(400).send({ error: "INVALID_REQUEST" });

      try {
        const result = await exchangeSelfServiceTelegram(
          (work) => runSqlTransaction(dependencies.pool, work),
          dependencies.verifier,
          dependencies.fingerprintSecret,
          body.initData,
          body.intent === "register",
          dependencies.ttlSeconds,
        );
        if (result)
          return reply.code(body.intent === "register" ? 201 : 200).send({
            tokenType: "Bearer",
            accessToken: result.token,
            scope: "identity",
            expiresAtUnixSeconds: result.expiresAtUnixSeconds,
          });

        // Old tenant-linked accounts retain their existing login until migration.
        if (body.intent === "login" && dependencies.legacySessions) {
          const legacy =
            await dependencies.legacySessions.exchangeTelegramInitData(
              body.initData,
            );
          if (legacy) {
            const checked = await dependencies.legacySessions.verifyBearerToken(
              legacy.bearerToken,
            );
            if (checked)
              return reply.code(200).send({
                tokenType: "Bearer",
                accessToken: legacy.bearerToken,
                identityId: checked.identityId,
                tenantId: checked.tenantId,
                scope: "tenant",
                expiresAtUnixSeconds: legacy.expiresAtUnixSeconds,
              });
          }
        }
        return reply.code(401).send({ error: "UNAUTHENTICATED" });
      } catch {
        return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
      }
    },
  );

  app.post("/v1/auth/identity/logout", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const token = /^Bearer (is_[A-Za-z0-9_-]{43})$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!token) return reply.code(401).send({ error: "UNAUTHENTICATED" });
    try {
      await dependencies.identitySessions.revoke(token);
      return reply.code(204).send();
    } catch {
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });
}
