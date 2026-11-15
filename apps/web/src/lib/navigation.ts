/** Frontend screen labels, not backend route or permission contracts. */
export type Screen =
  | "home"
  | "services"
  | "staff"
  | "schedule"
  | "calendar"
  | "locations"
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
  { id: "booking", label: "Онлайн-запись", glyph: "↗" },
];
