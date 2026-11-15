import Fastify, { type FastifyInstance } from "fastify";

import {
  SERVICE_NAME,
  type HealthResponse,
} from "../../../packages/contracts/src/index.js";
import { registerProtectedSessionContext, type ProtectedSessionDependencies } from "./session-context.js";

/** Only a health probe is exposed until Identity/Booking are built in later PRs. */
export interface DatabaseProbe {
  query(statement: string): Promise<unknown>;
}

export function createApp(
  database: DatabaseProbe,
  options: { readonly logger?: boolean; readonly sessionRoutes?: ProtectedSessionDependencies } = {},
): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 16_384,
  });

  app.get<{ Reply: HealthResponse }>("/health/live", async () => ({
    service: SERVICE_NAME,
    status: "ok",
  }));

  app.get<{ Reply: HealthResponse }>(
    "/health/ready",
    async (_request, reply) => {
      try {
        await database.query("SELECT 1");
        return { service: SERVICE_NAME, status: "ready" };
      } catch {
        // Never return the database connection string or driver errors to clients.
        return reply
          .status(503)
          .send({ service: SERVICE_NAME, status: "not-ready" });
      }
    },
  );

  // No session verifier is installed in the normal API bootstrap: fail closed.
  if (options.sessionRoutes) registerProtectedSessionContext(app, options.sessionRoutes);

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: "not-found" }),
  );

  return app;
}
