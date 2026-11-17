import type { VerifiedOwnerSession } from "./owner-auth";

export interface RealLocation {
  readonly id: string;
  readonly displayName: string;
  readonly timeZone: string | null;
  readonly createdAt: string;
}

export interface LocationDraft {
  readonly displayName: string;
  readonly timeZone: string;
}

export type LocationApiFailureReason =
  | "unauthorized"
  | "conflict"
  | "limit"
  | "unavailable"
  | "invalid-response";

export class LocationApiFailure extends Error {
  constructor(public readonly reason: LocationApiFailureReason) {
    super("Location request failed: " + reason);
    this.name = "LocationApiFailure";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ZONE = /^[A-Za-z][A-Za-z0-9_+./-]*$/;

function isLocation(value: unknown): value is RealLocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Partial<RealLocation>;
  return (
    typeof data.id === "string" &&
    UUID.test(data.id) &&
    typeof data.displayName === "string" &&
    !!data.displayName.trim() &&
    data.displayName.length <= 200 &&
    (data.timeZone === null ||
      (typeof data.timeZone === "string" &&
        data.timeZone.length <= 128 &&
        ZONE.test(data.timeZone))) &&
    typeof data.createdAt === "string" &&
    Number.isFinite(Date.parse(data.createdAt))
  );
}

async function request(
  session: VerifiedOwnerSession,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<{ readonly body: unknown; readonly status: number }> {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds) {
    throw new LocationApiFailure("unauthorized");
  }
  let response: Response;
  try {
    response = await fetcher(
      "/v1/organizations/" + session.tenantId + "/locations",
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
    throw new LocationApiFailure("unavailable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new LocationApiFailure("unauthorized");
  }
  if (response.status === 409) {
    let code = "";
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "error" in body) {
        code = String(body.error);
      }
    } catch {
      // Unknown conflict still cannot appear as a successful response.
    }
    throw new LocationApiFailure(
      code === "location-limit" ? "limit" : "conflict",
    );
  }
  if (!response.ok) throw new LocationApiFailure("unavailable");
  try {
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  } catch {
    throw new LocationApiFailure("invalid-response");
  }
}

export async function readRealLocations(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<RealLocation[]> {
  const result = await request(session, { method: "GET" }, fetcher);
  if (
    result.status !== 200 ||
    !result.body ||
    typeof result.body !== "object"
  ) {
    throw new LocationApiFailure("invalid-response");
  }
  const locations = (result.body as { locations?: unknown }).locations;
  if (
    !Array.isArray(locations) ||
    locations.length > 100 ||
    !locations.every(isLocation) ||
    new Set(locations.map((item: RealLocation) => item.id)).size !==
      locations.length
  ) {
    throw new LocationApiFailure("invalid-response");
  }
  return locations as RealLocation[];
}

export async function createRealLocation(
  session: VerifiedOwnerSession,
  draft: LocationDraft,
  idempotencyKey: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<RealLocation> {
  if (!UUID.test(idempotencyKey)) {
    throw new LocationApiFailure("invalid-response");
  }
  const result = await request(
    session,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(draft),
    },
    fetcher,
  );
  if (
    (result.status !== 200 && result.status !== 201) ||
    !result.body ||
    typeof result.body !== "object" ||
    !isLocation((result.body as { location?: unknown }).location) ||
    (result.body as { location: RealLocation }).location.timeZone === null
  ) {
    throw new LocationApiFailure("invalid-response");
  }
  return (result.body as { location: RealLocation }).location;
}
