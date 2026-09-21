/**
 * Flinder's strings (docs/assets/i18n/<lang>/flinder.json). English is bundled; another language is fetched
 * from the site's /assets/i18n/ before the page shows any text (main.ts awaits setupI18n()).
 *
 * What the flies text each other in a chat (lines.ts) stays as written: that is the flies talking. The page
 * around it, the profiles' jobs, bios, flags and prompts, the date outcomes and the share card are ours.
 */
import { setupPage, t, type Strings } from "../../../docs/assets/i18n/i18n.js";
import common from "../../../docs/assets/i18n/en/common.json";
import flinder from "../../../docs/assets/i18n/en/flinder.json";

export { t };

// word lists are arrays, read by index: flinder.profile.jobs.3
export const setupI18n = () => setupPage({ ns: ["flinder"], bundled: { common, flinder } as unknown as Record<string, Strings>, base: "/assets/i18n/" });

/** How many entries an English list has, e.g. size("profile.jobs"). */
function size(path: string): number {
  let v: unknown = flinder;
  for (const k of path.split(".")) v = (v as Record<string, unknown>)?.[k];
  return Array.isArray(v) ? v.length : 0;
}

/** Every entry of a list (flinder.<path>), in the page's language. */
export const listOf = (path: string): string[] => Array.from({ length: size(path) }, (_, i) => t(`flinder.${path}.${i}`));

/** One random entry of a list (flinder.<path>), in the page's language. */
export const anyOfT = (path: string, vars?: Record<string, string | number>): string =>
  t(`flinder.${path}.${Math.floor(Math.random() * size(path))}`, vars);
