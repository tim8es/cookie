/** Public infrastructure contracts only; business entities belong to domain modules. */
export const SERVICE_NAME = "cookie-api" as const;

export type HealthStatus = "ok" | "ready" | "not-ready";

export interface HealthResponse {
  readonly service: typeof SERVICE_NAME;
  readonly status: HealthStatus;
}
