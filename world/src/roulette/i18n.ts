/**
 * Fly Roulette's strings (docs/assets/i18n/<lang>/roulette.json). English is bundled; another language is
 * fetched from the site's /assets/i18n/ before the page shows any text (main.ts awaits setupI18n()).
 */
import { setupPage, t, type Strings } from "../../../docs/assets/i18n/i18n.js";
import common from "../../../docs/assets/i18n/en/common.json";
import roulette from "../../../docs/assets/i18n/en/roulette.json";

export { t };

// lists (the pop-up words) are arrays, read by index: roulette.pop.nervous.2
export const setupI18n = () => setupPage({ ns: ["roulette"], bundled: { common, roulette } as unknown as Record<string, Strings>, base: "/assets/i18n/" });

/** A random cartoon word from one of the pop-up lists (roulette.pop.<list>). */
export function anyPop(list: "nervous" | "chicken" | "phew"): string {
  return t(`roulette.pop.${list}.${Math.floor(Math.random() * roulette.pop[list].length)}`);
}
