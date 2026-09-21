import { locale } from "./i18n";

/** Seasons are 2-week rounds starting Monday 00:00 UTC; season 1 began Monday 7 September 2026.
 * At the end of each season the top 3 on the Season points board win $FLYAI. */
const START = Date.UTC(2026, 8, 7);
const LENGTH = 14 * 86_400_000;

export function currentSeason(now = new Date()) {
  const index = Math.max(0, Math.floor((now.getTime() - START) / LENGTH));
  const start = new Date(START + index * LENGTH);
  const end = new Date(START + (index + 1) * LENGTH);
  const lastDay = new Date(end.getTime() - 86_400_000);
  const day = (d: Date) => d.toLocaleString(locale(), { day: "numeric", month: "short", timeZone: "UTC" });
  return {
    number: index + 1,
    name: `${day(start)} – ${day(lastDay)}`,
    daysLeft: Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 86_400_000)),
  };
}
