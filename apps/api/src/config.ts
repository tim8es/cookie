export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
}

/** Parse configuration without logging credentials or silently accepting bad values. */
export function parseConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const rawPort = env.PORT ?? "3000";
  if (!/^[0-9]+$/.test(rawPort)) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.pathname ||
    parsed.pathname === "/"
  ) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }

  const host = env.HOST ?? "127.0.0.1";
  if (host.length === 0 || host.trim() !== host) {
    throw new Error("HOST must be a non-empty hostname");
  }

  return { host, port, databaseUrl };
}
