import { resolve } from "node:path";

import { Pool } from "pg";
import { createMigrationReadiness } from "../../../packages/platform-db/src/index.js";
import { parseStagingPublicationMode } from "../../../packages/domain-entitlement/src/index.js";

import { createApp } from "./app.js";
import { parseStagingCancellationCutoff } from "./staging-customer-cancellation-http.js";
import { parseConfig } from "./config.js";
import { registerCompiledWeb } from "./static-web.js";
import { createLiveTelegramSessionProvider } from "./telegram-auth-runtime.js";
import { postgresTenantPolicyGuard } from "./session-context.js";

const config = parseConfig(process.env);
const stagingPublicationEnabled = parseStagingPublicationMode(
  process.env.COOKIE_STAGING_PUBLICATION_MODE,
);
// Customer mutations require a second explicit controlled-staging opt-in.
const stagingCustomerBookingEnabled = parseStagingPublicationMode(
  process.env.COOKIE_STAGING_CUSTOMER_BOOKING_MODE,
);
if (stagingCustomerBookingEnabled && !stagingPublicationEnabled) {
  throw new Error("Staging customer booking requires staging publication");
}
const stagingCancellationCutoff = parseStagingCancellationCutoff(
  process.env.COOKIE_STAGING_CUSTOMER_CANCEL_CUTOFF_MINUTES,
);
if (stagingCancellationCutoff !== undefined && !stagingPublicationEnabled)
  throw new Error("Staging cancellation requires staging publication");
const pool = new Pool({
  connectionString: config.databaseUrl,
  application_name: "cookie-api",
  max: 5,
  // Keep connections available across the one-minute staging readiness probes.
  idleTimeoutMillis: 90_000,
  connectionTimeoutMillis: 3_000,
});
// pg emits idle-client failures on the pool itself. Without a listener a
// transient PostgreSQL outage can terminate Node before readiness can fail.
// pg removes the failed client; subsequent requests must still verify DB state.
pool.on("error", () => {
  console.error("Cookie API idle PostgreSQL connection lost");
});
const telegramSessions = createLiveTelegramSessionProvider(process.env, pool);
const app = createApp(pool, {
  logger: true,
  databaseReadiness: await createMigrationReadiness(
    pool,
    resolve(process.cwd(), "db/migrations"),
  ),
  ...(telegramSessions
    ? {
        telegramAuthRoutes: { sessions: telegramSessions },
        liveWorkspaceReads: { pool, verifier: telegramSessions },
        catalogRoutes: { pool, verifier: telegramSessions },
        appearanceDraftRoutes: { pool, verifier: telegramSessions },
        ownerCalendar: { pool, verifier: telegramSessions },
        staffRoutes: { pool, verifier: telegramSessions },
        locationRoutes: { pool, verifier: telegramSessions },
        shiftPlanRoutes: { pool, verifier: telegramSessions },
        stagingPublicationRoutes: {
          pool,
          verifier: telegramSessions,
          enabled: stagingPublicationEnabled,
        },
        stagingCustomerBookingRoutes: {
          pool,
          verifier: telegramSessions,
          enabled: stagingCustomerBookingEnabled,
        },
        ...(stagingCancellationCutoff === undefined
          ? {}
          : {
              stagingCustomerCancellationRoutes: {
                pool,
                verifier: telegramSessions,
                enabled: true,
                cutoffMinutes: stagingCancellationCutoff,
              },
            }),
        sessionRoutes: {
          verifier: telegramSessions,
          policy: postgresTenantPolicyGuard(pool),
        },
      }
    : {}),
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await app.close();
  } finally {
    await pool.end();
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  });
}

try {
  if (process.env.COOKIE_WEB_DIST) {
    // Optional same-origin compiled Svelte UI; absent or invalid files fail startup.
    await registerCompiledWeb(app, process.env.COOKIE_WEB_DIST);
  }
  await app.listen({ host: config.host, port: config.port });
} catch {
  // Avoid logging connection credentials from arbitrary upstream exceptions.
  app.log.error("Cookie API failed to start");
  process.exitCode = 1;
  await shutdown();
}
