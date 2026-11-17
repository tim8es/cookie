import type { SalonAppearance, SalonTheme } from "./model";

/** Curated accessible pairs for an isolated synthetic appearance preview only. */
export const salonThemes = [
  {
    id: "atelier",
    label: "Ателье",
    description: "Сдержанный сливовый и мягкий лайм",
    hero: "#3d2a48",
    ticket: "#4e345a",
    accent: "#e0f2a5",
    action: "#4c3358",
    actionHover: "#35243f",
    monogram: "#ede5ef",
    monogramInk: "#4a3153",
  },
  {
    id: "forest",
    label: "Ботаника",
    description: "Глубокий хвойный и тёплый кремовый",
    hero: "#24483b",
    ticket: "#315646",
    accent: "#e4eeb9",
    action: "#275144",
    actionHover: "#19392e",
    monogram: "#e3efe6",
    monogramInk: "#275144",
  },
  {
    id: "ocean",
    label: "Горизонт",
    description: "Чернильно-синий и прохладный голубой",
    hero: "#23455e",
    ticket: "#30556d",
    accent: "#cce8f2",
    action: "#28516e",
    actionHover: "#1a394d",
    monogram: "#e5eef5",
    monogramInk: "#23455e",
  },
  {
    id: "clay",
    label: "Терракота",
    description: "Тёплый шоколадный и пшеничный",
    hero: "#704234",
    ticket: "#805344",
    accent: "#f1dfa9",
    action: "#784736",
    actionHover: "#553025",
    monogram: "#f4e9e2",
    monogramInk: "#784736",
  },
] as const;

export const defaultSalonAppearance: SalonAppearance = {
  theme: "atelier",
  introduction: "Выберите услугу, специалиста и удобное время для визита.",
};

export function isSalonTheme(value: unknown): value is SalonTheme {
  return salonThemes.some((theme) => theme.id === value);
}

export function normalizeSalonAppearance(value: unknown): SalonAppearance {
  if (!value || typeof value !== "object") {
    return { ...defaultSalonAppearance };
  }
  const candidate = value as Partial<SalonAppearance>;
  return {
    theme: isSalonTheme(candidate.theme)
      ? candidate.theme
      : defaultSalonAppearance.theme,
    introduction:
      typeof candidate.introduction === "string" &&
      candidate.introduction.trim().length > 0 &&
      candidate.introduction.trim().length <= 120
        ? candidate.introduction.trim()
        : defaultSalonAppearance.introduction,
  };
}
