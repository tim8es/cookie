export interface SyntheticWorkerConfig {
  readonly databaseUrl: string;
}

/**
 * Strictly opt-in test runner. A normal production environment, arbitrary
 * DATABASE_URL, or missing acknowledgement cannot start the noop consumer.
 */
export function parseSyntheticWorkerConfig(
  env: NodeJS.ProcessEnv,
): SyntheticWorkerConfig {
  const ci = "postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci";
  const dev = "postgres://cookie_dev:cookie_dev@127.0.0.1:5432/cookie_dev";
  if (
    env.COOKIE_SYNTHETIC_WORKER !== "enabled" ||
    (env.DATABASE_URL !== ci && env.DATABASE_URL !== dev) ||
    (env.CI === "true" &&
      (env.DATABASE_URL !== ci || env.TEST_DATABASE_URL !== ci))
  ) {
    throw new Error(
      "Synthetic worker may only run on an explicit local/CI test database",
    );
  }
  return { databaseUrl: env.DATABASE_URL };
}
