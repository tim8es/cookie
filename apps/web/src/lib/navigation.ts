/** Frontend screen labels, not backend route or permission contracts. */
export type Screen =
  | "home"
  | "services"
  | "staff"
  | "schedule"
  | "calendar"
  | "locations"
  | "appearance"
  | "booking";

export interface NavigationItem {
  id: Screen;
  label: string;
  glyph: string;
}

export const screens: readonly NavigationItem[] = [
  { id: "home", label: "Обзор", glyph: "◫" },
  { id: "calendar", label: "Календарь", glyph: "▦" },
  { id: "services", label: "Услуги и цены", glyph: "◈" },
  { id: "staff", label: "Мастера", glyph: "♧" },
  { id: "schedule", label: "Расписание", glyph: "◷" },
  { id: "locations", label: "Филиалы", glyph: "⌂" },
  { id: "appearance", label: "Оформление", glyph: "◐" },
  { id: "booking", label: "Онлайн-запись", glyph: "↗" },
];

/** Owner-only presentation routes; paths never confer API authority. */
export const defaultOwnerScreen: Screen = "services";

export function ownerScreenPath(screen: Screen): string {
  return screen === "home" ? "/overview" : "/" + screen;
}

export function ownerScreenFromPath(path: string): Screen | null {
  if (path === "/") return defaultOwnerScreen;
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return (
    screens.find(({ id }) => ownerScreenPath(id) === normalized)?.id ?? null
  );
}

/**
 * Temporary fail-closed reservation for the proposed public salon URL family.
 * This does not resolve a salon, publish a URL, or grant any tenant authority.
 * Replace only after the #222 public catalog + proof contract is approved.
 */
export function isReservedPublicBookingPath(pathname: string): boolean {
  return pathname === "/book" || pathname.startsWith("/book/");
}

/** Preserve launch context; never place session or tenant claims in the URL. */
export function ownerRouteHref(
  screen: Screen,
  location: Pick<Location, "search" | "hash">,
): string {
  return ownerScreenPath(screen) + location.search + location.hash;
}
