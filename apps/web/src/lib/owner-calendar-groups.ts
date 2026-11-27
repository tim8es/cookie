import type { OwnerCalendar, OwnerCalendarEntry } from "./owner-calendar-api";

export interface CalendarGroup {
  readonly id: string;
  readonly label: string;
  readonly entries: OwnerCalendarEntry[];
}

/** Group only authorized server records; no availability or resource inference. */
export function groupCalendar(data: OwnerCalendar): CalendarGroup[] {
  const groups = new Map<string, CalendarGroup>();
  if (data.days === 1) {
    for (const entry of data.entries) {
      // Old servers omit staffId. Never merge records merely by display name.
      const id = entry.staffId
        ? "staff:" + entry.staffId
        : "booking:" + entry.id;
      let group = groups.get(id);
      if (!group) {
        group = { id, label: entry.staffName, entries: [] };
        groups.set(id, group);
      }
      group.entries.push(entry);
    }
    return [...groups.values()];
  }

  const label = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC",
    dateStyle: "full",
  });
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: data.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const start = Date.parse(data.localDate + "T00:00:00Z");
  for (let index = 0; index < data.days; index++) {
    const day = new Date(start + index * 86400000);
    const id = day.toISOString().slice(0, 10);
    groups.set(id, { id, label: label.format(day), entries: [] });
  }
  for (const entry of data.entries) {
    const parts = local.formatToParts(new Date(entry.startAt));
    const part = (type: string) => parts.find((p) => p.type === type)?.value;
    const date = part("year") + "-" + part("month") + "-" + part("day");
    // A visit overlapping the beginning of the period belongs in the first
    // displayed day, with its full original start/end shown in the card.
    const id = date < data.localDate ? data.localDate : date;
    let group = groups.get(id);
    if (!group) {
      // Do not silently drop an unexpected record from the server.
      group = { id, label: id, entries: [] };
      groups.set(id, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}
