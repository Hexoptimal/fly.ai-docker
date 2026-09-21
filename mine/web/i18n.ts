/**
 * The compute pages' language: the site's shared runtime (docs/assets/i18n/) with the "compute" strings,
 * fetched from /assets/i18n/. Importing this waits until the strings are loaded and the page's marked-up HTML
 * is translated, so every module that imports it can call t() at any time, even at its top level.
 * Main thread only: workers have no document and never import it.
 */
import { locale, setupPage, t } from "../../docs/assets/i18n/i18n.js";

await setupPage({ ns: ["compute"], base: "/assets/i18n/" });

export { locale, t };
