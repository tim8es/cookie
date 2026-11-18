import { resolve } from "node:path";

import { Pool } from "pg";
import { createMigrationReadiness } from "../../../packages/platform-db/src/index.js";
import { parseStagingPublicationMode } from "../../../packages/domain-entitlement/src/index.js";

import { createApp } from "./app.js";
import { parseStagingCancellationCutoff } from "./staging-customer-cancellation-http.js";
import { parseConfig } from "./config.js";
import { registerCompiledWeb } from "./static-web.js";
import {
  createLiveTelegramIdentityAuth,
  createLiveTelegramSessionProvider,
} from "./telegram-auth-runtime.js";
import {
  createLiveEmailIdentityAuth,
  startAuthMailWorker,
} from "./email-auth-runtime.js";
import { createLiveTelegramOidcAuth } from "./telegram-oidc-runtime.js";
import { postgresTenantPolicyGuard } from "./session-context.js";
import { createTenantSessionVerifier } from "./tenant-session-verifier.js";

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
const emailIdentityAuth = createLiveEmailIdentityAuth(process.env, pool);
const telegramIdentityAuth = createLiveTelegramIdentityAuth(
  process.env,
  pool,
  telegramSessions ?? undefined,
  emailIdentityAuth ? [emailIdentityAuth.sessions] : [],
);
const telegramOidcAuth = createLiveTelegramOidcAuth(
  process.env,
  pool,
  telegramIdentityAuth?.identitySessionProviders[0],
);
const identitySessionProviders = [
  ...new Set([
    ...(telegramIdentityAuth?.identitySessionProviders ?? []),
    ...(emailIdentityAuth ? [emailIdentityAuth.sessions] : []),
    ...(telegramOidcAuth ? [telegramOidcAuth.sessions] : []),
  ]),
];
const tenantSessionVerifier = createTenantSessionVerifier(
  telegramSessions,
  identitySessionProviders,
);
const app = createApp(pool, {
  logger: true,
  databaseReadiness: await createMigrationReadiness(
    pool,
    resolve(process.cwd(), "db/migrations"),
  ),
  ...(tenantSessionVerifier
    ? {
        ...(telegramSessions
          ? { telegramAuthRoutes: { sessions: telegramSessions } }
          : {}),
        liveWorkspaceReads: { pool, verifier: tenantSessionVerifier },
        catalogRoutes: { pool, verifier: tenantSessionVerifier },
        appearanceDraftRoutes: { pool, verifier: tenantSessionVerifier },
        ownerCalendar: { pool, verifier: tenantSessionVerifier },
        staffRoutes: { pool, verifier: tenantSessionVerifier },
        locationRoutes: { pool, verifier: tenantSessionVerifier },
        shiftPlanRoutes: { pool, verifier: tenantSessionVerifier },
        stagingPublicationRoutes: {
          pool,
          verifier: tenantSessionVerifier,
          enabled: stagingPublicationEnabled,
          identitySessionProviders,
        },
        stagingCustomerBookingRoutes: {
          pool,
          verifier: tenantSessionVerifier,
          enabled: stagingCustomerBookingEnabled,
        },
        ...(stagingCancellationCutoff === undefined
          ? {}
          : {
              stagingCustomerCancellationRoutes: {
                pool,
                verifier: tenantSessionVerifier,
                enabled: true,
                cutoffMinutes: stagingCancellationCutoff,
              },
            }),
        sessionRoutes: {
          verifier: tenantSessionVerifier,
          policy: postgresTenantPolicyGuard(pool),
        },
      }
    : {}),
  ...(telegramIdentityAuth
    ? { telegramIdentityRoutes: telegramIdentityAuth }
    : {}),
  ...(telegramOidcAuth
    ? {
        telegramOidcRoutes: {
          ...telegramOidcAuth.routes,
          identitySessionProviders,
        },
      }
    : {}),
  ...(emailIdentityAuth
    ? {
        emailIdentityRoutes: {
          ...emailIdentityAuth.routes,
          identitySessionProviders,
        },
      }
    : {}),
  ...(identitySessionProviders.length > 0 ? { identitySessionProviders } : {}),
  ...(identitySessionProviders.length > 0 ? { identitySessionPool: pool } : {}),
  ...(identitySessionProviders.length > 0
    ? { ownerWorkspaceEnrollment: { pool, identitySessionProviders } }
    : {}),
});

let stopping = false;
let stopEmailWorker: () => Promise<void> = async () => undefined;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await stopEmailWorker();
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
  if (emailIdentityAuth) {
    stopEmailWorker = startAuthMailWorker(emailIdentityAuth.worker, () =>
      app.log.warn("Auth email worker iteration failed"),
    );
  }
} catch {
  // Avoid logging connection credentials from arbitrary upstream exceptions.
  app.log.error("Cookie API failed to start");
  process.exitCode = 1;
  await shutdown();
}
