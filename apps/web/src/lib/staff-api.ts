import type { VerifiedOwnerSession } from "./owner-auth";

export interface RealStaffLocation {
  readonly id: string;
  readonly displayName: string;
}
export interface RealStaffAssignment {
  readonly locationId: string;
  readonly serviceIds: readonly string[];
}
export interface RealStaff {
  readonly id: string;
  readonly displayName: string;
  readonly positionTitle: string;
  readonly active: boolean;
  readonly bookable: boolean;
  readonly createdAt: string;
  readonly assignments: readonly RealStaffAssignment[];
}
export interface StaffDirectory {
  readonly staff: readonly RealStaff[];
  readonly locations: readonly RealStaffLocation[];
}
export interface RealStaffDraft {
  readonly displayName: string;
  readonly positionTitle: string;
  readonly locationId: string;
  readonly serviceId: string;
}
export type StaffFailureReason =
  | "unauthorized"
  | "conflict"
  | "missing-reference"
  | "unavailable"
  | "invalid-response";
export class StaffApiFailure extends Error {
  constructor(public readonly reason: StaffFailureReason) {
    super("Staff request failed: " + reason);
    this.name = "StaffApiFailure";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isLocation(value: unknown): value is RealStaffLocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Partial<RealStaffLocation>;
  return (
    typeof data.id === "string" &&
    UUID.test(data.id) &&
    typeof data.displayName === "string" &&
    !!data.displayName.trim() &&
    data.displayName.length <= 200
  );
}
function isAssignment(value: unknown): value is RealStaffAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Partial<RealStaffAssignment>;
  return (
    typeof data.locationId === "string" &&
    UUID.test(data.locationId) &&
    Array.isArray(data.serviceIds) &&
    data.serviceIds.length <= 100 &&
    data.serviceIds.every(
      (id: unknown) => typeof id === "string" && UUID.test(id),
    ) &&
    new Set(data.serviceIds).size === data.serviceIds.length
  );
}
function isStaff(value: unknown): value is RealStaff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Partial<RealStaff>;
  return (
    typeof data.id === "string" &&
    UUID.test(data.id) &&
    typeof data.displayName === "string" &&
    !!data.displayName.trim() &&
    data.displayName.length <= 200 &&
    typeof data.positionTitle === "string" &&
    data.positionTitle.length <= 80 &&
    typeof data.active === "boolean" &&
    typeof data.bookable === "boolean" &&
    typeof data.createdAt === "string" &&
    Number.isFinite(Date.parse(data.createdAt)) &&
    Array.isArray(data.assignments) &&
    data.assignments.length <= 100 &&
    data.assignments.every(isAssignment) &&
    new Set(data.assignments.map((a: RealStaffAssignment) => a.locationId))
      .size === data.assignments.length
  );
}
function uniqueIds(rows: readonly { id: string }[]): boolean {
  return new Set(rows.map((row) => row.id)).size === rows.length;
}
async function request(
  session: VerifiedOwnerSession,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<{ body: unknown; status: number }> {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds) {
    throw new StaffApiFailure("unauthorized");
  }
  let response: Response;
  try {
    response = await fetcher(
      "/v1/organizations/" + session.tenantId + "/staff",
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
    throw new StaffApiFailure("unavailable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new StaffApiFailure("unauthorized");
  }
  if (response.status === 409) throw new StaffApiFailure("conflict");
  if (response.status === 404) throw new StaffApiFailure("missing-reference");
  if (!response.ok) throw new StaffApiFailure("unavailable");
  try {
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  } catch {
    throw new StaffApiFailure("invalid-response");
  }
}

export async function readRealStaff(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<StaffDirectory> {
  const result = await request(session, { method: "GET" }, fetcher);
  if (
    result.status !== 200 ||
    !result.body ||
    typeof result.body !== "object"
  ) {
    throw new StaffApiFailure("invalid-response");
  }
  const candidate = result.body as Partial<StaffDirectory>;
  if (
    !Array.isArray(candidate.staff) ||
    !Array.isArray(candidate.locations) ||
    candidate.staff.length > 100 ||
    candidate.locations.length > 100 ||
    !candidate.staff.every(isStaff) ||
    !candidate.locations.every(isLocation) ||
    !uniqueIds(candidate.staff) ||
    !uniqueIds(candidate.locations)
  ) {
    throw new StaffApiFailure("invalid-response");
  }
  const locationIds = new Set(
    candidate.locations.map((location) => location.id),
  );
  if (
    candidate.staff.some((staff) =>
      staff.assignments.some(
        (assignment) => !locationIds.has(assignment.locationId),
      ),
    )
  ) {
    throw new StaffApiFailure("invalid-response");
  }
  return { staff: candidate.staff, locations: candidate.locations };
}

export async function createRealStaff(
  session: VerifiedOwnerSession,
  draft: RealStaffDraft,
  idempotencyKey: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<RealStaff> {
  if (!UUID.test(idempotencyKey)) throw new StaffApiFailure("invalid-response");
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
    !isStaff((result.body as { staff?: unknown }).staff)
  ) {
    throw new StaffApiFailure("invalid-response");
  }
  return (result.body as { staff: RealStaff }).staff;
}
