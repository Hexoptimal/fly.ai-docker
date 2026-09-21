/**
 * The site's languages for the world pages (the Simulation, Fly Radio): the shared runtime in docs/assets/i18n/, with
 * English bundled so it never waits on a fetch. Browser-only: the world server (server/) never imports this.
 */
import { init, languagePicker, reveal, setupPage, t, translateDOM } from "../../docs/assets/i18n/i18n.js";
import common from "../../docs/assets/i18n/en/common.json";
import radio from "../../docs/assets/i18n/en/radio.json";
import sim from "../../docs/assets/i18n/en/sim.json";

export { t };

const BASE = "/assets/i18n/";
const BUNDLED = { common, sim, radio };

/** t, or `fallback` when English has no such key either: for labels made from data (a fly's state, a cause of death). */
export function tx(key: string, fallback: string, vars?: Record<string, string | number>): string {
  const v = t(key, vars);
  return v === key ? fallback : v;
}

/** A key segment for a name that may hold dots or spaces ("DLM MN" -> "DLM_MN"). */
export const keyOf = (name: string) => name.replace(/[^A-Za-z0-9]/g, "_");

/** The Simulation, which has its own header instead of the site nav: translate, then a language menu in the header. */
export async function setupSim(menuHost: HTMLElement): Promise<void> {
  try {
    await init({ ns: ["common", "sim"], bundled: BUNDLED, base: BASE });
    translateDOM();
    languagePicker(menuHost);
  } finally {
    reveal();
  }
}

/** Fly Radio, which has the site nav: the whole page setup, language menu in the nav. */
export async function setupRadio(): Promise<void> {
  await setupPage({ ns: ["radio"], bundled: BUNDLED, base: BASE });
}

/** The connectome workers' loading lines ("connectome 12 / 58 MB", "wiring 25 M synapses"), in the page's language. */
export function progress(ns: "sim.wiz.status" | "radio.status", text: string): string {
  const m = /^(labels|connectome) (.*) MB$/.exec(text);
  if (m) return t(`${ns}.${m[1]}`, { mb: m[2] });
  if (text === "wiring 25 M synapses") return t(`${ns}.wiring`);
  return text;
}
