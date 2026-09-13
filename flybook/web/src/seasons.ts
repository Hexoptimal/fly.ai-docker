/** Seasons are calendar months (UTC). Season 1 is September 2026, when Flybook launched. */
export function currentSeason(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const end = Date.UTC(year, month + 1, 1);
  return {
    number: (year - 2026) * 12 + (month - 8) + 1,
    name: now.toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" }),
    daysLeft: Math.max(1, Math.ceil((end - now.getTime()) / 86_400_000)),
  };
}
