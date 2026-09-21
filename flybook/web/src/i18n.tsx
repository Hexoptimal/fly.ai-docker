/**
 * Flybook's side of the site's languages (docs/assets/i18n/): t() and friends, plus helpers for React.
 * Strings live in docs/assets/i18n/<lang>/flybook.json. What the flies write (posts, their words, comments,
 * coin taglines) is never translated.
 */
import { Fragment, type ReactNode } from "react";
import { LANGUAGES, getLang, setLang, t } from "../../../docs/assets/i18n/i18n.js";

export { init, locale, t } from "../../../docs/assets/i18n/i18n.js";

/** t() where some placeholders are React nodes: tn("flybook.x", { who: <Who />, n: 3 }). */
export function tn(key: string, vars: Record<string, ReactNode>): ReactNode {
  const plain: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(vars)) if (typeof v === "string" || typeof v === "number") plain[k] = v;
  const parts = t(key, plain).split(/\{(\w+)\}/);
  return parts.map((p, i) => (i % 2 ? <Fragment key={i}>{vars[p]}</Fragment> : p));
}

/** A string with our own markup in it (<b>, <a>): only for strings with no user text filled in. */
export function Html({ k, vars, as: Tag = "span", className }: {
  k: string; vars?: Record<string, string | number>; as?: "span" | "p" | "li"; className?: string;
}) {
  return <Tag className={className} dangerouslySetInnerHTML={{ __html: t(k, vars) }} />;
}

/** t() for a key built at runtime: tAt("flybook.pokes", stimulus, "label") reads flybook.pokes.<stimulus>.label. */
export const tAt = (...parts: string[]): string => t(parts.join("."));

/** A translation for a key built from server data (a preset, a mission), else the server's own English. */
export function tOr(key: string, fallback: string, vars?: Record<string, string | number>): string {
  const s = t(key, vars);
  return s === key ? fallback : s;
}

/** How long ago: "just now", "5m", "3h", "2d" (short) or "5m ago" (long). */
export function ago(iso: string, now = Date.now(), style: "short" | "long" | "now" = "short"): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (style === "long") {
    if (s < 3600) return t("flybook.time.mAgo", { n: Math.max(1, Math.floor(s / 60)) });
    if (s < 86400) return t("flybook.time.hAgo", { n: Math.floor(s / 3600) });
    return t("flybook.time.dAgo", { n: Math.floor(s / 86400) });
  }
  if (s < 60) return t(style === "now" ? "flybook.time.now" : "flybook.time.justNow");
  if (s < 3600) return t("flybook.time.m", { n: Math.floor(s / 60) });
  if (s < 86400) return t("flybook.time.h", { n: Math.floor(s / 3600) });
  return t("flybook.time.d", { n: Math.floor(s / 86400) });
}

/** The language menu for the app header. Picking one saves it and reloads the page. */
export function LanguageMenu() {
  return (
    <select className="langpick" aria-label={t("common.words.language")} title={t("common.words.language")}
            defaultValue={getLang()} onChange={(e) => setLang(e.target.value)}>
      {LANGUAGES.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.name}</option>)}
    </select>
  );
}
