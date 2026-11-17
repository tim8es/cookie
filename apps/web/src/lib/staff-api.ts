import type { VerifiedOwnerSession } from "./owner-auth";

export interface RealStaffProfile {
  readonly id: string;
  readonly displayName: string;
  readonly positionTitle: string | null;
  readonly active: boolean;
  readonly bookable: boolean;
  readonly createdAt: string;
}

export interface StaffDraft {
  readonly displayName: string;
  readonly positionTitle: string;
}

export type StaffApiFailureReason =
  | "unauthorized"
  | "conflict"
  | "unavailable"
  | "invalid-response";

export class StaffApiFailure extends Error {
  constructor(public readonly reason: StaffApiFailureReason) {
    super("Staff request failed: " + reason);
    this.name = "StaffApiFailure";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRealStaff(value: unknown): value is RealStaffProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Partial<RealStaffProfile>;
  return (
    typeof profile.id === "string" &&
    UUID.test(profile.id) &&
    typeof profile.displayName === "string" &&
    profile.displayName.length <= 200 &&
    !!profile.displayName.trim() &&
    (profile.positionTitle === null ||
      (typeof profile.positionTitle === "string" &&
        profile.positionTitle.length <= 100 &&
        !!profile.positionTitle.trim())) &&
    typeof profile.active === "boolean" &&
    typeof profile.bookable === "boolean" &&
    (!profile.bookable || profile.active) &&
    typeof profile.createdAt === "string" &&
    Number.isFinite(Date.parse(profile.createdAt))
  );
}

async function request(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch,
  init: RequestInit,
): Promise<{ readonly body: unknown; readonly status: number }> {
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
  if (!response.ok) throw new StaffApiFailure("unavailable");
  try {
    return {
      body: (await response.json()) as unknown,
      status: response.status,
    };
  } catch {
    throw new StaffApiFailure("invalid-response");
  }
}

export async function readRealStaff(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<RealStaffProfile[]> {
  const result = await request(session, fetcher, { method: "GET" });
  if (
    result.status !== 200 ||
    !result.body ||
    typeof result.body !== "object"
  ) {
    throw new StaffApiFailure("invalid-response");
  }
  const staff = (result.body as { staff?: unknown }).staff;
  if (
    !Array.isArray(staff) ||
    staff.length > 100 ||
    !staff.every(isRealStaff) ||
    new Set(staff.map((item: RealStaffProfile) => item.id)).size !== staff.length
  ) {
    throw new StaffApiFailure("invalid-response");
  }
  return staff as RealStaffProfile[];
}

export async function createRealStaff(
  session: VerifiedOwnerSession,
  draft: StaffDraft,
  idempotencyKey: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<RealStaffProfile> {
  if (!UUID.test(idempotencyKey)) {
    throw new StaffApiFailure("invalid-response");
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
    !isRealStaff((result.body as { staff?: unknown }).staff) ||
    (result.body as { staff: RealStaffProfile }).staff.bookable
  ) {
    throw new StaffApiFailure("invalid-response");
  }
  return (result.body as { staff: RealStaffProfile }).staff;
}
