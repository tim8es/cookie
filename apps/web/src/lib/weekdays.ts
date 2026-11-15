/** UI weekday labels, with Sunday represented as 0 (JavaScript Date convention). */
export const weekdays = [
  { number: 1, name: "Пн" },
  { number: 2, name: "Вт" },
  { number: 3, name: "Ср" },
  { number: 4, name: "Чт" },
  { number: 5, name: "Пт" },
  { number: 6, name: "Сб" },
  { number: 0, name: "Вс" },
] as const;
