import type { VerifiedOwnerSession } from "./owner-auth";

export interface ShiftPlan {
  readonly shiftId: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly active: false;
  readonly revision: number;
}

export interface ShiftPlanDraft {
  readonly staffId: string;
  readonly locationId: string;
  readonly startLocal: string;
  readonly endLocal: string;
}

export type ShiftPlanErrorReason =
  | "unauthorized"
  | "target-unavailable"
  | "invalid-time"
  | "conflict"
  | "unavailable"
  | "invalid-response";

export class ShiftPlanError extends Error {
  constructor(public readonly reason: ShiftPlanErrorReason) {
    super("Shift plan: " + reason);
    this.name = "ShiftPlanError";
  }
}

/** A later rejection cannot disprove an earlier possibly committed shift. */
export function shiftPlanSaveIsUncertain(
  previous: boolean,
  reason: unknown,
): boolean {
  return (
    previous ||
    !(reason instanceof ShiftPlanError) ||
    reason.reason === "unavailable" ||
    reason.reason === "invalid-response"
  );
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function isPlan(value: unknown): value is ShiftPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<ShiftPlan>;
  return (
    typeof plan.shiftId === "string" &&
    UUID.test(plan.shiftId) &&
    typeof plan.staffId === "string" &&
    UUID.test(plan.staffId) &&
    typeof plan.locationId === "string" &&
    UUID.test(plan.locationId) &&
    isInstant(plan.startAt) &&
    isInstant(plan.endAt) &&
    Date.parse(plan.endAt) > Date.parse(plan.startAt) &&
    Date.parse(plan.endAt) - Date.parse(plan.startAt) <= 48 * 60 * 60 * 1000 &&
    plan.active === false &&
    Number.isSafeInteger(plan.revision) &&
    (plan.revision ?? -1) >= 0
  );
}

async function request(
  session: VerifiedOwnerSession,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<{ body: unknown; status: number }> {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds) {
    throw new ShiftPlanError("unauthorized");
  }
  let response: Response;
  try {
    response = await fetcher(
      "/v1/organizations/" + session.tenantId + "/shift-plans",
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
    throw new ShiftPlanError("unavailable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new ShiftPlanError("unauthorized");
  }
  if (response.status === 400 || response.status === 422) {
    throw new ShiftPlanError("invalid-time");
  }
  if (response.status === 409) {
    const reason: unknown = await response.json().catch(() => null);
    if (
      reason &&
      typeof reason === "object" &&
      "error" in reason &&
      reason.error === "target-unavailable"
    ) {
      throw new ShiftPlanError("target-unavailable");
    }
    throw new ShiftPlanError("conflict");
  }
  if (!response.ok) throw new ShiftPlanError("unavailable");
  try {
    return {
      body: (await response.json()) as unknown,
      status: response.status,
    };
  } catch {
    throw new ShiftPlanError("invalid-response");
  }
}

export async function readShiftPlans(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<{ plans: ShiftPlan[]; hasMore: boolean }> {
  const result = await request(session, { method: "GET" }, fetcher);
  if (result.status !== 200 || !result.body || typeof result.body !== "object")
    throw new ShiftPlanError("invalid-response");
  const data = result.body as { plans?: unknown; hasMore?: unknown };
  if (
    !Array.isArray(data.plans) ||
    data.plans.length > 200 ||
    !data.plans.every(isPlan) ||
    typeof data.hasMore !== "boolean" ||
    new Set(data.plans.map((plan: ShiftPlan) => plan.shiftId)).size !==
      data.plans.length
  )
    throw new ShiftPlanError("invalid-response");
  return { plans: data.plans, hasMore: data.hasMore };
}

export async function createShiftPlan(
  session: VerifiedOwnerSession,
  draft: ShiftPlanDraft,
  key: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ShiftPlan> {
  if (!UUID.test(key)) throw new ShiftPlanError("invalid-response");
  const result = await request(
    session,
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(draft),
    },
    fetcher,
  );
  if (
    (result.status !== 200 && result.status !== 201) ||
    !result.body ||
    typeof result.body !== "object"
  )
    throw new ShiftPlanError("invalid-response");
  const plan = (result.body as { plan?: unknown }).plan;
  if (
    !isPlan(plan) ||
    plan.staffId !== draft.staffId ||
    plan.locationId !== draft.locationId
  )
    throw new ShiftPlanError("invalid-response");
  return plan;
}
