import Fastify, { type FastifyInstance } from "fastify";

import {
  SERVICE_NAME,
  type HealthResponse,
} from "../../../packages/contracts/src/index.js";
import {
  registerSyntheticBookingMutations,
  type SyntheticBookingMutationDependencies,
} from "./booking-http-mutations.js";
import {
  registerSyntheticBookingHttp,
  type SyntheticBookingHttpDependencies,
} from "./booking-http.js";
import {
  registerSyntheticWorkspaceReads,
  type SyntheticWorkspaceReadDependencies,
} from "./workspace-http.js";
import { registerTelegramAuthExchange } from "./telegram-auth-http.js";
import { registerStagingPublicationRoutes, type StagingPublicationDependencies } from "./staging-publication-http.js";
import {
  registerOwnerShiftPlanRoutes,
  type OwnerShiftPlanRouteDependencies,
} from "./owner-shift-plan-http.js";
import {
  registerRealLocationRoutes,
  type RealLocationRouteDependencies,
} from "./locations-http.js";
import {
  registerRealCatalogRoutes,
  type RealCatalogRouteDependencies,
} from "./catalog-http.js";
import {
  registerRealStaffRoutes,
  type RealStaffRoutesDependencies,
} from "./staff-http.js";
import {
  registerProtectedSessionContext,
  type ProtectedSessionDependencies,
} from "./session-context.js";

/** Only a health probe is exposed until Identity/Booking are built in later PRs. */
export interface DatabaseProbe {
  query(statement: string): Promise<unknown>;
}

export function createApp(
  database: DatabaseProbe,
  options: {
    readonly logger?: boolean;
    readonly sessionRoutes?: ProtectedSessionDependencies;
    readonly catalogRoutes?: RealCatalogRouteDependencies;
    readonly staffRoutes?: RealStaffRoutesDependencies;
    readonly locationRoutes?: RealLocationRouteDependencies;
    readonly shiftPlanRoutes?: OwnerShiftPlanRouteDependencies;
    readonly stagingPublicationRoutes?: StagingPublicationDependencies;
    readonly telegramAuthRoutes?: {
      readonly sessions: import("../../../packages/platform-identity/src/opaque-sessions.js").PostgresOpaqueTelegramSessions;
    };
    readonly syntheticBookingRoutes?: SyntheticBookingHttpDependencies;
    readonly syntheticBookingMutations?: SyntheticBookingMutationDependencies;
    readonly syntheticWorkspaceReads?: SyntheticWorkspaceReadDependencies;
  } = {},
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
  if (options.sessionRoutes)
    registerProtectedSessionContext(app, options.sessionRoutes);

  // One-time Telegram proof exchange only when configured with real HMAC,
  // a database-resolved trusted link and HTTPS origin. No Booking enabled.
  if (options.telegramAuthRoutes)
    registerTelegramAuthExchange(app, options.telegramAuthRoutes.sessions);

  // Real Catalog requires an independently verified bearer and transactional SQL policy.
  if (options.catalogRoutes)
    registerRealCatalogRoutes(app, options.catalogRoutes);

  if (options.staffRoutes) registerRealStaffRoutes(app, options.staffRoutes);

  // Owner-controlled Locations are real tenant-scoped rows, never anonymous.
  if (options.locationRoutes)
    registerRealLocationRoutes(app, options.locationRoutes);

  if (options.shiftPlanRoutes)
    registerOwnerShiftPlanRoutes(app, options.shiftPlanRoutes);

  if (options.stagingPublicationRoutes)
    registerStagingPublicationRoutes(app, options.stagingPublicationRoutes);

  // Explicit injection only: ordinary main.ts never supplies an AuthN adapter or
  // synthetic entitlement callback, so these booking routes stay absent.
  if (options.syntheticBookingRoutes)
    registerSyntheticBookingHttp(app, options.syntheticBookingRoutes);

  // Business-side cancel/reschedule is also explicitly test-only. Both
  // mandatory transactional policy ports must be injected by the harness.
  if (options.syntheticBookingMutations)
    registerSyntheticBookingMutations(app, options.syntheticBookingMutations);

  // No workspace or staff schedule read route in normal production startup.
  if (options.syntheticWorkspaceReads)
    registerSyntheticWorkspaceReads(app, options.syntheticWorkspaceReads);

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: "not-found" }),
  );

  return app;
}
