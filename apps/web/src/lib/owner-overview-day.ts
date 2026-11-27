import type { OwnerCalendarEntry } from "./owner-calendar-api";

/** Presentation-only summary of the complete authorized calendar response. */
export function summarizeOwnerDay(entries: readonly OwnerCalendarEntry[]) {
  let confirmedPriceKopecks = 0;
  let staffKnown = true;
  const staff = new Set<string>();
  for (const entry of entries) {
    if (entry.status !== "Confirmed") continue;
    // Calendar validates at most 500 entries and 12 digits per price.
    // Their integer-kopek sum is exactly representable as a JS number.
    confirmedPriceKopecks += Number(entry.priceKopecks);
    if (entry.staffId) staff.add(entry.staffId);
    else staffKnown = false;
  }
  return {
    entries: entries.length,
    confirmedPriceKopecks,
    confirmedStaff: staffKnown ? staff.size : null,
  };
}
