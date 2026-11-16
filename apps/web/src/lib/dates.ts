/** Calendar-only formatting helpers. No availability, pricing, or booking policy. */
export function localDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
export function parseDay(day: string): Date {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}
export function offsetDay(day: string, offset: number): string {
  const next = parseDay(day);
  next.setDate(next.getDate() + offset);
  return localDay(next);
}
export function mondayOf(day: string): string {
  const date = parseDay(day);
  const weekday = (date.getDay() + 6) % 7;
  return offsetDay(day, -weekday);
}
export function upcomingWeekday(from: string, weekdays: number[]): string {
  for (let i = 0; i < 7; i += 1) {
    const candidate = offsetDay(from, i);
    if (weekdays.includes(parseDay(candidate).getDay())) return candidate;
  }
  return from;
}
export function longDate(day: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    weekday: "long",
  }).format(parseDay(day));
}
export function shortDate(day: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
  }).format(parseDay(day));
}
export function money(rubles: number): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(rubles);
}
