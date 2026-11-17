import type { VerifiedOwnerSession } from "./owner-auth";

export interface RealService {
  readonly id: string;
  readonly displayName: string;
  readonly durationMinutes: number;
  readonly basePriceKopecks: number;
  readonly active: boolean;
  readonly createdAt: string;
}

export type ServiceFailureReason =
  | "unauthorized"
  | "conflict"
  | "unavailable"
  | "invalid-response";
export class ServiceApiFailure extends Error {
  constructor(public readonly reason: ServiceFailureReason) {
    super("Catalog request failed: " + reason);
    this.name = "ServiceApiFailure";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRealService(value: unknown): value is RealService {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Partial<RealService>;
  return (
    typeof s.id === "string" &&
    UUID.test(s.id) &&
    typeof s.displayName === "string" &&
    !!s.displayName.trim() &&
    s.displayName.length <= 200 &&
    Number.isInteger(s.durationMinutes) &&
    s.durationMinutes! >= 1 &&
    s.durationMinutes! <= 1440 &&
    Number.isSafeInteger(s.basePriceKopecks) &&
    s.basePriceKopecks! >= 0 &&
    s.basePriceKopecks! <= 999_999_999_999 &&
    typeof s.active === "boolean" &&
    typeof s.createdAt === "string" &&
    Number.isFinite(Date.parse(s.createdAt))
  );
}

async function request(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch,
  init: RequestInit,
): Promise<{ body: unknown; status: number }> {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds) {
    throw new ServiceApiFailure("unauthorized");
  }
  let response: Response;
  try {
    response = await fetcher(
      "/v1/organizations/" + session.tenantId + "/services",
      {
        ...init,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: "Bearer " + session.accessToken,
        },
      },
    );
  } catch {
    throw new ServiceApiFailure("unavailable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new ServiceApiFailure("unauthorized");
  }
  if (response.status === 409) throw new ServiceApiFailure("conflict");
  if (!response.ok) throw new ServiceApiFailure("unavailable");
  try {
    return {
      body: (await response.json()) as unknown,
      status: response.status,
    };
  } catch {
    throw new ServiceApiFailure("invalid-response");
  }
}

export async function readRealServices(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<RealService[]> {
  const result = await request(session, fetcher, { method: "GET" });
  if (
    result.status !== 200 ||
    !result.body ||
    typeof result.body !== "object"
  ) {
    throw new ServiceApiFailure("invalid-response");
  }
  const records = (result.body as { services?: unknown }).services;
  if (
    !Array.isArray(records) ||
    records.length > 100 ||
    !records.every(isRealService) ||
    new Set(records.map((s: RealService) => s.id)).size !== records.length
  ) {
    throw new ServiceApiFailure("invalid-response");
  }
  return records as RealService[];
}

export interface RealServiceDraft {
  readonly displayName: string;
  readonly durationMinutes: number;
  readonly basePriceKopecks: number;
}

export async function createRealService(
  session: VerifiedOwnerSession,
  draft: RealServiceDraft,
  idempotencyKey: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<RealService> {
  if (!UUID.test(idempotencyKey)) {
    throw new ServiceApiFailure("invalid-response");
  }
  const result = await request(session, fetcher, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(draft),
  });
  if (
    (result.status !== 200 && result.status !== 201) ||
    !result.body ||
    typeof result.body !== "object" ||
    !isRealService((result.body as { service?: unknown }).service)
  ) {
    throw new ServiceApiFailure("invalid-response");
  }
  return (result.body as { service: RealService }).service;
}
