import type { VerifiedOwnerSession } from "./owner-auth";

export interface StagingCapacity {
  readonly state:
    | "disabled"
    | "unconfigured"
    | "active"
    | "expired"
    | "revoked";
  readonly seatLimit: number | null;
  readonly usedSeats: number;
  readonly expiresAt: string | null;
}
export interface StagingPublicationInput {
  readonly staffId: string;
  readonly locationId: string;
  readonly serviceId: string;
  readonly expectedServiceRevision: number;
}
export type StagingPublicationErrorReason =
  | "unauthorized"
  | "grant-unavailable"
  | "seat-limit"
  | "target-unavailable"
  | "already-bookable"
  | "stale-revision"
  | "idempotency-conflict"
  | "unavailable"
  | "invalid-response";
export class StagingPublicationError extends Error {
  constructor(readonly reason: StagingPublicationErrorReason) {
    super(reason);
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFLICTS = new Set<string>([
  "grant-unavailable",
  "seat-limit",
  "target-unavailable",
  "already-bookable",
  "stale-revision",
  "idempotency-conflict",
]);
function isCapacity(value: unknown): value is StagingCapacity {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<StagingCapacity>;
  if (!Number.isSafeInteger(c.usedSeats) || c.usedSeats! < 0) return false;
  if (c.state === "disabled" || c.state === "unconfigured")
    return c.seatLimit === null && c.expiresAt === null;
  return (
    (c.state === "active" || c.state === "expired" || c.state === "revoked") &&
    Number.isSafeInteger(c.seatLimit) &&
    c.seatLimit! > 0 &&
    typeof c.expiresAt === "string" &&
    Number.isFinite(Date.parse(c.expiresAt))
  );
}
async function request(
  session: VerifiedOwnerSession,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<{ body: unknown; status: number }> {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds)
    throw new StagingPublicationError("unauthorized");
  let response: Response;
  try {
    response = await fetcher(
      "/v1/organizations/" + session.tenantId + "/staging-publication",
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
    throw new StagingPublicationError("unavailable");
  }
  if (response.status === 401 || response.status === 403)
    throw new StagingPublicationError("unauthorized");
  if (response.status === 404)
    throw new StagingPublicationError("grant-unavailable");
  if (response.status === 409) {
    const problem: unknown = await response.json().catch(() => null);
    if (
      problem &&
      typeof problem === "object" &&
      "error" in problem &&
      typeof problem.error === "string" &&
      CONFLICTS.has(problem.error)
    )
      throw new StagingPublicationError(
        problem.error as StagingPublicationErrorReason,
      );
  }
  if (!response.ok) throw new StagingPublicationError("unavailable");
  try {
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  } catch {
    throw new StagingPublicationError("invalid-response");
  }
}

export async function readStagingPublicationCapacity(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<StagingCapacity> {
  const result = await request(session, { method: "GET" }, fetcher);
  if (result.status !== 200 || !result.body || typeof result.body !== "object")
    throw new StagingPublicationError("invalid-response");
  const data = (result.body as { capacity?: unknown }).capacity;
  if (!isCapacity(data)) throw new StagingPublicationError("invalid-response");
  return data;
}

export async function publishStagingStaff(
  session: VerifiedOwnerSession,
  input: StagingPublicationInput,
  key: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  if (
    !UUID.test(key) ||
    !UUID.test(input.staffId) ||
    !UUID.test(input.locationId) ||
    !UUID.test(input.serviceId) ||
    !Number.isSafeInteger(input.expectedServiceRevision) ||
    input.expectedServiceRevision < 0 ||
    input.expectedServiceRevision >= 2147483647
  )
    throw new StagingPublicationError("invalid-response");
  const result = await request(
    session,
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(input),
    },
    fetcher,
  );
  if (
    ![200, 201].includes(result.status) ||
    !result.body ||
    typeof result.body !== "object"
  )
    throw new StagingPublicationError("invalid-response");
  const receipt = (result.body as { publication?: unknown }).publication;
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !("staffId" in receipt) ||
    receipt.staffId !== input.staffId ||
    !("locationId" in receipt) ||
    receipt.locationId !== input.locationId ||
    !("serviceId" in receipt) ||
    receipt.serviceId !== input.serviceId
  )
    throw new StagingPublicationError("invalid-response");
}
