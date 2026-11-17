import type { VerifiedOwnerSession } from "./owner-auth";
import type { ShiftPlan } from "./shift-plans-api";

export interface PublishedShift extends Omit<ShiftPlan, "active" | "revision"> {
  readonly active: true;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validShift(value: unknown): value is PublishedShift {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<PublishedShift>;
  return (
    typeof s.shiftId === "string" &&
    UUID.test(s.shiftId) &&
    typeof s.staffId === "string" &&
    UUID.test(s.staffId) &&
    typeof s.locationId === "string" &&
    UUID.test(s.locationId) &&
    typeof s.startAt === "string" &&
    typeof s.endAt === "string" &&
    Number.isFinite(Date.parse(s.startAt)) &&
    Date.parse(s.endAt) > Date.parse(s.startAt) &&
    s.active === true
  );
}

async function request(
  session: VerifiedOwnerSession,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<unknown> {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds)
    throw new Error("unauthorized");
  const response = await fetcher(
    "/v1/organizations/" + session.tenantId + "/staging-shift-publication",
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
  if (response.status === 401 || response.status === 403)
    throw new Error("unauthorized");
  if (response.status === 404) throw new Error("disabled");
  if (response.status === 409) {
    const body: unknown = await response.json().catch(() => null);
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
    )
      throw new Error(body.error);
  }
  if (response.status !== 200) throw new Error("unavailable");
  return response.json();
}

export async function readPublishedShifts(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<{ published: PublishedShift[]; hasMore: boolean }> {
  const body = await request(session, { method: "GET" }, fetcher);
  if (!body || typeof body !== "object") throw new Error("invalid-response");
  const data = body as { published?: unknown; hasMore?: unknown };
  if (
    !Array.isArray(data.published) ||
    data.published.length > 200 ||
    !data.published.every(validShift) ||
    new Set(data.published.map((shift) => shift.shiftId)).size !==
      data.published.length ||
    typeof data.hasMore !== "boolean"
  )
    throw new Error("invalid-response");
  return { published: data.published, hasMore: data.hasMore };
}

export async function publishStagingShift(
  session: VerifiedOwnerSession,
  draft: ShiftPlan,
  key: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<PublishedShift> {
  if (!UUID.test(key) || !UUID.test(draft.shiftId))
    throw new Error("invalid-request");
  const body = await request(
    session,
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({
        shiftId: draft.shiftId,
        expectedRevision: draft.revision,
      }),
    },
    fetcher,
  );
  if (!body || typeof body !== "object" || !("publication" in body))
    throw new Error("invalid-response");
  const shift = body.publication;
  if (
    !validShift(shift) ||
    shift.shiftId !== draft.shiftId ||
    shift.staffId !== draft.staffId ||
    shift.locationId !== draft.locationId ||
    shift.startAt !== draft.startAt ||
    shift.endAt !== draft.endAt
  )
    throw new Error("invalid-response");
  return shift;
}
