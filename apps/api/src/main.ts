import { Pool } from "pg";

import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { registerCompiledWeb } from "./static-web.js";
import { createLiveTelegramSessionProvider } from "./telegram-auth-runtime.js";
import { postgresTenantPolicyGuard } from "./session-context.js";

const config = parseConfig(process.env);
const pool = new Pool({
  connectionString: config.databaseUrl,
  application_name: "cookie-api",
  max: 5,
  connectionTimeoutMillis: 3_000,
});
const telegramSessions = createLiveTelegramSessionProvider(process.env, pool);
const app = createApp(pool, {
  logger: true,
  ...(telegramSessions
    ? {
        telegramAuthRoutes: { sessions: telegramSessions },
        liveWorkspaceReads: { pool, verifier: telegramSessions },
        catalogRoutes: { pool, verifier: telegramSessions },
        staffRoutes: { pool, verifier: telegramSessions },
        locationRoutes: { pool, verifier: telegramSessions },
        shiftPlanRoutes: { pool, verifier: telegramSessions },
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
