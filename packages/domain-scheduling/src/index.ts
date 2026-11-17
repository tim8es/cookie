/**
 * Pure scheduling calculation for F1. Inputs MUST be loaded by trusted,
 * tenant-scoped server read ports; this module is not an authorization or DB
 * concurrency boundary. CreateBooking must revalidate inside a transaction.
 *
 * Shifts/breaks/exceptions are absolute UTC intervals resolved from the
 * location's IANA time zone by the Scheduling adapter. The localDate filter
 * handles DST without inventing or silently resolving ambiguous local times.
 */
export interface UtcInterval {
  readonly startAt: string;
  readonly endAt: string;
}

export interface StaffOccupancy {
  readonly organizationId: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly startAt: string;
  /** Includes the post-service buffer, not merely the client-visible end. */
  readonly occupiedUntil: string;
}

export interface AvailabilityRequest {
  readonly organizationId: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly localDate: string;
  readonly timeZone: string;
  /** Single Service duration shared across staff and locations, in minutes. */
  readonly serviceDurationMinutes: number;
  readonly postServiceBufferMinutes: number;
  /** Configurable grid anchored at each shift's UTC start. */
  readonly stepMinutes: number;
  /** Working intervals at the selected location, converted to UTC. */
  readonly shifts: readonly UtcInterval[];
  readonly breaks: readonly UtcInterval[];
  readonly exceptions: readonly UtcInterval[];
  /** ALL active occupied intervals for this staff across ALL locations. */
  readonly occupied: readonly StaffOccupancy[];
}

export interface AvailableSlot {
  readonly startAt: string;
  /** Client-visible end, excluding the post-service buffer. */
  readonly endAt: string;
  /** Staff occupancy end, including the post-service buffer. */
  readonly occupiedUntil: string;
}

interface NumericInterval {
  readonly start: number;
  readonly end: number;
}

interface Prepared {
  readonly request: AvailabilityRequest;
  readonly dateFormatter: Intl.DateTimeFormat;
  readonly durationMs: number;
  readonly occupiedDurationMs: number;
  readonly stepMs: number;
  readonly shifts: readonly NumericInterval[];
  readonly unavailable: readonly NumericInterval[];
}

const MINUTE = 60_000;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function parseInstant(value: string): number {
  if (!UTC_INSTANT.test(value)) {
    throw new RangeError("Expected ISO 8601 UTC instant with Z suffix");
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw new RangeError("Invalid UTC instant");
  }
  return timestamp;
}

function parseInterval(startAt: string, endAt: string): NumericInterval {
  const start = parseInstant(startAt);
  const end = parseInstant(endAt);
  if (end <= start) throw new RangeError("Time interval must be non-empty");
  if (end - start > 48 * 60 * MINUTE) {
    throw new RangeError(
      "Time interval exceeds the supported 48-hour F1 window",
    );
  }
  return { start, end };
}

function assertMinutes(value: number, name: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > 1_440) {
    throw new RangeError(
      `${name} must be an integer between ${min} and 1440 minutes`,
    );
  }
}

function assertLocalDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError("localDate must be YYYY-MM-DD");
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value
  ) {
    throw new RangeError("Invalid localDate");
  }
}

function prepare(request: AvailabilityRequest): Prepared {
  if (!request.organizationId || !request.staffId || !request.locationId) {
    throw new RangeError("Tenant, staff and location identifiers are required");
  }
  assertLocalDate(request.localDate);
  assertMinutes(request.serviceDurationMinutes, "serviceDurationMinutes", 1);
  assertMinutes(
    request.postServiceBufferMinutes,
    "postServiceBufferMinutes",
    0,
  );
  assertMinutes(request.stepMinutes, "stepMinutes", 1);

  // RangeError is intentional for an invalid IANA timeZone.
  const dateFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: request.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  for (const occupancy of request.occupied) {
    // Never silently discard an unexpected tenant/staff occupancy snapshot.
    if (
      occupancy.organizationId !== request.organizationId ||
      occupancy.staffId !== request.staffId ||
      !occupancy.locationId
    ) {
      throw new RangeError(
        "Occupied intervals must be trusted and tenant/staff-scoped",
      );
    }
  }

  return {
    request,
    dateFormatter,
    durationMs: request.serviceDurationMinutes * MINUTE,
    occupiedDurationMs:
      (request.serviceDurationMinutes + request.postServiceBufferMinutes) *
      MINUTE,
    stepMs: request.stepMinutes * MINUTE,
    shifts: request.shifts.map((item) =>
      parseInterval(item.startAt, item.endAt),
    ),
    unavailable: [
      ...request.breaks.map((item) => parseInterval(item.startAt, item.endAt)),
      ...request.exceptions.map((item) =>
        parseInterval(item.startAt, item.endAt),
      ),
      ...request.occupied.map((item) =>
        parseInterval(item.startAt, item.occupiedUntil),
      ),
    ],
  };
}

function localDateAt(
  formatter: Intl.DateTimeFormat,
  timestamp: number,
): string {
  const parts = formatter.formatToParts(new Date(timestamp));
  const get = (kind: string): string =>
    parts.find((part) => part.type === kind)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function intersects(
  leftStart: number,
  leftEnd: number,
  right: NumericInterval,
): boolean {
  // Half-open [start, end): adjacent appointments do NOT conflict.
  return leftStart < right.end && right.start < leftEnd;
}

function availableAt(prepared: Prepared, start: number): AvailableSlot | null {
  const end = start + prepared.durationMs;
  const occupiedUntil = start + prepared.occupiedDurationMs;
  if (localDateAt(prepared.dateFormatter, start) !== prepared.request.localDate)
    return null;
  const fittingShift = prepared.shifts.some(
    (shift) =>
      start >= shift.start &&
      occupiedUntil <= shift.end &&
      (start - shift.start) % prepared.stepMs === 0,
  );
  if (!fittingShift) return null;
  if (
    prepared.unavailable.some((interval) =>
      intersects(start, occupiedUntil, interval),
    )
  ) {
    return null;
  }
  return {
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    occupiedUntil: new Date(occupiedUntil).toISOString(),
  };
}

/**
 * Read-side provisional slots only. Callers must authorize/tenant-scope reads,
 * and re-check every mutable condition under the same DB transaction as create.
 */
export function listAvailableSlots(
  request: AvailabilityRequest,
): AvailableSlot[] {
  const prepared = prepare(request);
  const slots = new Map<number, AvailableSlot>();
  for (const shift of prepared.shifts) {
    for (
      let start = shift.start;
      start + prepared.occupiedDurationMs <= shift.end;
      start += prepared.stepMs
    ) {
      const slot = availableAt(prepared, start);
      if (slot) slots.set(start, slot);
    }
  }
  return [...slots.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, slot]) => slot);
}

/**
 * Rejects starts outside the shift's booking grid. Never a substitute for the
 * server-side transaction/exclusion constraint that commits a Confirmed booking.
 */
export function evaluateAvailableStart(
  request: AvailabilityRequest,
  startAt: string,
): AvailableSlot | null {
  const prepared = prepare(request);
  return availableAt(prepared, parseInstant(startAt));
}

/** Branch-local civil time conversion; rejects gaps and folds. */
export { resolveLocalMinute } from "./local-minute.js";
export { validateLocalMinute } from "./local-minute.js";
export { PublishShiftFailure } from "./publish-shift.js";
export {
  listStagingPublishedShifts,
  publishStagingShift,
} from "./staging-shift-publication.js";
export {
  previewStagingAvailability,
  PreviewUnavailable,
  type AvailabilitySelection,
} from "./staging-availability.js";

/** Protected owner planning commands; never publish or enable booking. */
export {
  createOwnerShiftPlan,
  DraftShiftFailure,
  type OwnerShiftPlanInput,
} from "./draft-shift.js";
export { listOwnerShiftPlans } from "./owner-shift-plans.js";
