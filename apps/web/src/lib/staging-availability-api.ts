import type { VerifiedOwnerSession } from "./owner-auth";

export interface PreviewSelection {
  readonly staffId: string;
  readonly locationId: string;
  readonly serviceId: string;
  readonly localDate: string;
}
export interface PreviewSlot {
  readonly startAt: string;
  readonly endAt: string;
  readonly occupiedUntil: string;
}
export interface SlotPreview {
  readonly localDate: string;
  readonly timeZone: string;
  readonly slots: PreviewSlot[];
}
export class StagingAvailabilityError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function isSlot(value: unknown): value is PreviewSlot {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<PreviewSlot>;
  return (
    instant(s.startAt) &&
    instant(s.endAt) &&
    instant(s.occupiedUntil) &&
    Date.parse(s.endAt) > Date.parse(s.startAt) &&
    Date.parse(s.occupiedUntil) >= Date.parse(s.endAt)
  );
}
async function request(
  session: VerifiedOwnerSession,
  path: string,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<unknown> {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds)
    throw new StagingAvailabilityError("unauthorized");
  let response: Response;
  try {
    response = await fetcher("/v1/organizations/" + session.tenantId + path, {
      ...init,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        ...(init.headers as Record<string, string>),
        authorization: "Bearer " + session.accessToken,
      },
    });
  } catch {
    throw new StagingAvailabilityError("unavailable");
  }
  if (response.status === 401 || response.status === 403)
    throw new StagingAvailabilityError("unauthorized");
  if (response.status === 404)
    throw new StagingAvailabilityError("shift-unavailable");
  if (response.status === 400)
    throw new StagingAvailabilityError("invalid-request");
  if (response.status === 409) {
    const data: unknown = await response.json().catch(() => null);
    if (
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof data.error === "string"
    )
      throw new StagingAvailabilityError(data.error);
    throw new StagingAvailabilityError("conflict");
  }
  if (response.status !== 200)
    throw new StagingAvailabilityError("unavailable");
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new StagingAvailabilityError("invalid-response");
  }
}
export async function previewStagingSlots(
  session: VerifiedOwnerSession,
  selection: PreviewSelection,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<SlotPreview> {
  if (
    !UUID.test(selection.staffId) ||
    !UUID.test(selection.locationId) ||
    !UUID.test(selection.serviceId) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(selection.localDate)
  )
    throw new StagingAvailabilityError("invalid-request");
  const params = new URLSearchParams({ ...selection });
  const body = await request(
    session,
    "/staging-availability?" + params.toString(),
    { method: "GET" },
    fetcher,
  );
  if (!body || typeof body !== "object")
    throw new StagingAvailabilityError("invalid-response");
  const s = body as Partial<SlotPreview>;
  if (
    s.localDate !== selection.localDate ||
    typeof s.timeZone !== "string" ||
    !Array.isArray(s.slots) ||
    s.slots.length > 1500 ||
    !s.slots.every(isSlot) ||
    new Set(s.slots.map((slot) => slot.startAt)).size !== s.slots.length
  )
    throw new StagingAvailabilityError("invalid-response");
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: s.timeZone }).format();
  } catch {
    throw new StagingAvailabilityError("invalid-response");
  }
  return { localDate: s.localDate, timeZone: s.timeZone, slots: s.slots };
}
