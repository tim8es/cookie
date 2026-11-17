/**
 * Resolve branch-local civil minutes using an authoritative IANA zone.
 * Never apply the browser's own zone or silently pick an occurrence of
 * an ambiguous fall-back minute. F1 handles minute-aligned future shifts.
 */
const LOCAL_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MINUTE_MS = 60_000;

export function validateLocalMinute(value: unknown): number {
  if (typeof value !== "string" || !LOCAL_MINUTE.test(value)) {
    throw new RangeError("Invalid local minute");
  }
  const ms = Date.parse(value + ":00Z");
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 16) !== value) {
    throw new RangeError("Invalid local date");
  }
  return ms;
}

function formattedMinute(formatter: Intl.DateTimeFormat, ms: number): string {
  const parts = formatter.formatToParts(new Date(ms));
  const part = (key: string) => parts.find((value) => value.type === key)?.value ?? "";
  return part("year") + "-" + part("month") + "-" + part("day") +
    "T" + part("hour") + ":" + part("minute");
}

export function resolveLocalMinute(value: string, timeZone: string): string {
  const naive = validateLocalMinute(value);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  // Sample the offsets on both sides of a potential transition. Every
  // candidate must round-trip to the exact requested civil minute. Zero
  // matches is a gap; multiple matches is a fold. Reject both explicitly.
  const offsets = new Set<number>();
  for (let hour = -36; hour <= 36; hour++) {
    const probe = naive + hour * 60 * MINUTE_MS;
    const parts = formattedMinute(formatter, probe);
    offsets.add(validateLocalMinute(parts) - probe);
  }
  const candidates = [...offsets]
    .map((offset) => naive - offset)
    .filter((ms) => formattedMinute(formatter, ms) === value);
  if (candidates.length !== 1) {
    throw new RangeError("Missing or ambiguous local minute");
  }
  return new Date(candidates[0]!).toISOString();
}
