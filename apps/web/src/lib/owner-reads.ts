import { readRealLocations, type RealLocation } from "./locations-api";
import {
  readOwnerCalendar,
  type CalendarDays,
  type OwnerCalendar,
} from "./owner-calendar-api";
import type { VerifiedOwnerSession } from "./owner-auth";
import { readRealServices } from "./services-api";
import { readShiftPlans } from "./shift-plans-api";
import { readRealStaff } from "./staff-api";
import { readRealWorkspaceOverview } from "./workspace-overview-api";

export function createOwnerRead<T>(
  read: () => Promise<T>,
  active: () => boolean,
  now = Date.now,
) {
  let snapshot: { value: T; timestamp: number } | undefined;
  let pending: Promise<T> | undefined;

  function invalidate(): void {
    snapshot = undefined;
    pending = undefined;
  }

  function peek(): T | undefined {
    return active() && snapshot && now() - snapshot.timestamp < 30_000
      ? snapshot.value
      : undefined;
  }

  async function load(force = false): Promise<T> {
    if (!active()) throw new Error("Workspace session ended");
    if (pending) return pending;
    if (!force && snapshot && now() - snapshot.timestamp < 5_000)
      return snapshot.value;

    const request = read().then(
      (value) => {
        if (!active()) throw new Error("Workspace session ended");
        if (pending !== request) return load();
        snapshot = { value, timestamp: now() };
        pending = undefined;
        return value;
      },
      (error: unknown) => {
        if (pending === request) invalidate();
        throw error;
      },
    );
    pending = request;
    return request;
  }

  return { peek, load, invalidate };
}

type CalendarBranch = Pick<RealLocation, "id" | "displayName" | "timeZone">;

export function branchToday(zone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (kind: string) => parts.find((p) => p.type === kind)?.value;
  return part("year") + "-" + part("month") + "-" + part("day");
}

export function createOwnerReads(session: VerifiedOwnerSession) {
  let closed = false;
  const active = () =>
    !closed && Date.now() < session.expiresAtUnixSeconds * 1000;
  const overview = createOwnerRead(
    () => readRealWorkspaceOverview(session),
    active,
  );
  const locations = createOwnerRead(() => readRealLocations(session), active);
  const services = createOwnerRead(() => readRealServices(session), active);
  const staff = createOwnerRead(() => readRealStaff(session), active);
  const shifts = createOwnerRead(() => readShiftPlans(session), active);
  const calendars = new Map<
    string,
    ReturnType<typeof createOwnerRead<OwnerCalendar>>
  >();

  function calendar(locationId: string, date: string, days: CalendarDays) {
    const key = [locationId, date, days].join(":");
    const existing = calendars.get(key);
    if (existing) {
      calendars.delete(key);
      calendars.set(key, existing);
      return existing;
    }
    if (calendars.size >= 8) {
      const oldest = calendars.keys().next().value;
      if (oldest !== undefined) calendars.delete(oldest);
    }
    const slot = createOwnerRead(
      () => readOwnerCalendar(session, locationId, date, days),
      active,
    );
    calendars.set(key, slot);
    return slot;
  }

  function peekCalendarBranches(): CalendarBranch[] | undefined {
    return (
      locations.peek() ??
      overview
        .peek()
        ?.locations.map(({ locationId, displayName, timeZone }) => ({
          id: locationId,
          displayName,
          timeZone,
        }))
    );
  }

  async function calendarBranches(): Promise<CalendarBranch[]> {
    return peekCalendarBranches() ?? locations.load();
  }

  function invalidateCalendars(): void {
    for (const slot of calendars.values()) slot.invalidate();
  }

  return {
    overview,
    locations,
    services,
    staff,
    shifts,
    calendar,
    peekCalendarBranches,
    calendarBranches,
    invalidateCalendars,
    close() {
      closed = true;
      for (const slot of [overview, locations, services, staff, shifts])
        slot.invalidate();
      calendars.clear();
    },
  };
}

export type OwnerReads = ReturnType<typeof createOwnerReads>;
