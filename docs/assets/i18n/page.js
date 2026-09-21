/**
 * The docs pages' language setup: <html data-i18n-ns="index"> names the page's own strings file (common.json
 * is always loaded). Translates the page, adds the language menu to the nav, and exposes window.flyI18n
 * ({ t, lang }) for the pages' plain scripts (site.js).
 */
import { getLang, setupPage } from "./i18n.js";

const ns = (document.documentElement.dataset.i18nNs || "").split(/\s+/).filter(Boolean);
const t = await setupPage({ ns });
// notes meant only for a translated page (e.g. "the English version is the binding one")
if (getLang() !== "en") for (const el of document.querySelectorAll("[data-i18n-show-translated]")) el.hidden = false;
window.flyI18n = { t, lang: getLang() };
window.dispatchEvent(new Event("i18n:ready"));
