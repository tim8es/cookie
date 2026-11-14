import { Pool } from "pg";

import { createApp } from "./app.js";
import { parseConfig } from "./config.js";

const config = parseConfig(process.env);
const pool = new Pool({
  connectionString: config.databaseUrl,
  application_name: "cookie-api",
  max: 5,
  connectionTimeoutMillis: 3_000,
});
const app = createApp(pool, { logger: true });

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
  await app.listen({ host: config.host, port: config.port });
} catch {
  // Avoid logging connection credentials from arbitrary upstream exceptions.
  app.log.error("Cookie API failed to start");
  process.exitCode = 1;
  await shutdown();
}
