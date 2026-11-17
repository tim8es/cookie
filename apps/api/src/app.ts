import Fastify, { type FastifyInstance } from "fastify";

import {
  registerRealAppearanceRoutes,
  type RealAppearanceRouteDependencies,
} from "./appearance-http.js";

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
import { registerStagingAvailabilityRoutes } from "./staging-availability-http.js";
import {
  registerStagingCustomerCancellation,
  type StagingCancellationDependencies,
} from "./staging-customer-cancellation-http.js";
import { registerStagingCustomerBooking } from "./staging-customer-booking-http.js";
import { registerStagingCustomerHistory } from "./staging-customer-history-http.js";
import { registerStagingCustomerOffers } from "./staging-customer-offers-http.js";
import { registerStagingCustomerContext } from "./staging-customer-http.js";
import { registerTelegramAuthExchange } from "./telegram-auth-http.js";
import {
  registerTelegramIdentityAuth,
  type TelegramIdentityAuthDependencies,
} from "./telegram-identity-auth-http.js";
import {
  registerStagingPublicationRoutes,
  type StagingPublicationDependencies,
} from "./staging-publication-http.js";
import {
  registerOwnerCalendar,
  type OwnerCalendarDependencies,
} from "./owner-calendar-http.js";
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
  registerLiveWorkspaceRead,
  type LiveWorkspaceReadDependencies,
} from "./live-workspace-http.js";
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
    readonly databaseReadiness?: () => Promise<void>;
    readonly appearanceDraftRoutes?: Pick<
      RealAppearanceRouteDependencies,
      "pool" | "verifier"
    >;
    readonly sessionRoutes?: ProtectedSessionDependencies;
    readonly liveWorkspaceReads?: LiveWorkspaceReadDependencies;
    readonly catalogRoutes?: RealCatalogRouteDependencies;
    readonly staffRoutes?: RealStaffRoutesDependencies;
    readonly locationRoutes?: RealLocationRouteDependencies;
    readonly shiftPlanRoutes?: OwnerShiftPlanRouteDependencies;
    readonly stagingPublicationRoutes?: StagingPublicationDependencies;
    readonly stagingCustomerBookingRoutes?: StagingPublicationDependencies;
    readonly stagingCustomerCancellationRoutes?: StagingCancellationDependencies;
    readonly ownerCalendar?: OwnerCalendarDependencies;
    readonly telegramAuthRoutes?: {
      readonly sessions: import("../../../packages/platform-identity/src/index.js").PostgresOpaqueTelegramSessions;
    };
    readonly telegramIdentityRoutes?: TelegramIdentityAuthDependencies;
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
        if (options.databaseReadiness) {
          await options.databaseReadiness();
        } else {
          // Low-level injected app fixtures use the connectivity-only probe.
          await database.query("SELECT 1");
        }
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
  if (options.telegramIdentityRoutes)
    registerTelegramIdentityAuth(app, options.telegramIdentityRoutes);

  if (options.appearanceDraftRoutes)
    registerRealAppearanceRoutes(app, {
      ...options.appearanceDraftRoutes,
      draftOnly: true,
    });

  if (options.catalogRoutes)
    registerRealCatalogRoutes(app, options.catalogRoutes);

  if (options.staffRoutes) registerRealStaffRoutes(app, options.staffRoutes);

  // Owner-controlled Locations are tenant-scoped rows, never anonymous.
  if (options.locationRoutes)
    registerRealLocationRoutes(app, options.locationRoutes);

  if (options.shiftPlanRoutes)
    registerOwnerShiftPlanRoutes(app, options.shiftPlanRoutes);

  if (options.ownerCalendar) registerOwnerCalendar(app, options.ownerCalendar);

  if (options.stagingPublicationRoutes) {
    registerStagingPublicationRoutes(app, options.stagingPublicationRoutes);
    registerStagingCustomerContext(app, options.stagingPublicationRoutes);
    registerStagingCustomerOffers(app, options.stagingPublicationRoutes);
    registerStagingCustomerHistory(app, options.stagingPublicationRoutes);
    registerStagingAvailabilityRoutes(app, options.stagingPublicationRoutes);
  }

  // Independent opt-in. Normal runtime cannot mount this candidate yet.
  if (options.stagingCustomerBookingRoutes)
    registerStagingCustomerBooking(app, options.stagingCustomerBookingRoutes);
  if (options.stagingCustomerCancellationRoutes)
    registerStagingCustomerCancellation(
      app,
      options.stagingCustomerCancellationRoutes,
    );

  // Explicit injection only: ordinary main.ts never supplies an AuthN adapter or
  // synthetic entitlement callback, so these booking routes stay absent.
  if (options.syntheticBookingRoutes)
    registerSyntheticBookingHttp(app, options.syntheticBookingRoutes);

  // Business-side cancel/reschedule is also explicitly test-only. Both
  // mandatory transactional policy ports must be injected by the harness.
  if (options.syntheticBookingMutations)
    registerSyntheticBookingMutations(app, options.syntheticBookingMutations);

  if (options.liveWorkspaceReads && options.syntheticWorkspaceReads) {
    throw new Error("Cannot mix production and synthetic Workspace routes");
  }
  if (options.liveWorkspaceReads)
    registerLiveWorkspaceRead(app, options.liveWorkspaceReads);

  // Synthetic workspace reads remain test-only.
  if (options.syntheticWorkspaceReads)
    registerSyntheticWorkspaceReads(app, options.syntheticWorkspaceReads);

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: "not-found" }),
  );

  return app;
}
