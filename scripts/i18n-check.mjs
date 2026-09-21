#!/usr/bin/env node
/**
 * Checks the site's translations (docs/assets/i18n/): node scripts/i18n-check.mjs
 *   - every language in LANGUAGES has a folder, and every English file exists in it
 *   - no key is missing or extra against English, and each string keeps English's {placeholders} and HTML tags
 *   - every key the pages and apps use (data-i18n*, t("...")) exists in English
 * Missing strings still work on the site (they show in English), so they are listed as warnings; broken
 * placeholders, tags and unknown keys are errors (exit 1).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(REPO, "docs/assets/i18n");
const { LANGUAGES } = await import(new URL(`file:///${join(DIR, "i18n.js").replace(/\\/g, "/")}`).href);

const errors = [];
const warnings = [];
const read = (f) => JSON.parse(readFileSync(f, "utf8"));

/** key path -> value, for strings and plural objects */
function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[key] = v;
    else if (v && typeof v === "object" && typeof v.other === "string") for (const [f, s] of Object.entries(v)) out[`${key}#${f}`] = s;
    else if (v && typeof v === "object") flatten(v, key, out);
  }
  return out;
}
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const tags = (s) => [...s.matchAll(/<\/?([a-z][a-z0-9]*)\b/gi)].map((m) => m[0].toLowerCase()).sort().join(",");

const enFiles = readdirSync(join(DIR, "en")).filter((f) => f.endsWith(".json"));
const en = Object.fromEntries(enFiles.map((f) => [f.replace(/\.json$/, ""), flatten(read(join(DIR, "en", f)))]));

for (const { code } of LANGUAGES) {
  if (code === "en") continue;
  if (!existsSync(join(DIR, code))) { errors.push(`${code}: no folder docs/assets/i18n/${code}/`); continue; }
  for (const ns of Object.keys(en)) {
    const file = join(DIR, code, `${ns}.json`);
    if (!existsSync(file)) { warnings.push(`${code}/${ns}.json: missing (all ${Object.keys(en[ns]).length} strings show in English)`); continue; }
    let cur;
    try { cur = flatten(read(file)); } catch (e) { errors.push(`${code}/${ns}.json: ${e.message}`); continue; }
    const missing = Object.keys(en[ns]).filter((k) => !(k in cur) && !k.includes("#"));
    if (missing.length) warnings.push(`${code}/${ns}.json: ${missing.length} missing: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", ..." : ""}`);
    for (const [k, v] of Object.entries(cur)) {
      const base = k.split("#")[0];
      const enVal = en[ns][k] ?? en[ns][`${base}#other`] ?? en[ns][base];
      if (enVal === undefined) { errors.push(`${code}/${ns}.json: extra key ${k}`); continue; }
      // plural forms may drop {count} (e.g. "one" written out), so only check the "other" form
      if ((!k.includes("#") || k.endsWith("#other")) && placeholders(v) !== placeholders(enVal)) errors.push(`${code}/${ns}.json: ${k} placeholders {${placeholders(v)}} vs English {${placeholders(enVal)}}`);
      if (tags(v) !== tags(enVal)) errors.push(`${code}/${ns}.json: ${k} HTML tags differ from English`);
      // a plain-text string (data-i18n, t()) would show an entity literally
      if (/&(#\d+|[a-z]+);/i.test(v) && !/&(#\d+|[a-z]+);|<\w/i.test(enVal)) errors.push(`${code}/${ns}.json: ${k} has an HTML entity but English is plain text: write the character`);
    }
  }
}

// keys used by pages and code must exist in English
const enKeys = new Set();
for (const [ns, flat] of Object.entries(en)) for (const k of Object.keys(flat)) {
  const parts = `${ns}.${k.split("#")[0]}`.split(".");
  for (let i = 2; i <= parts.length; i++) enKeys.add(parts.slice(0, i).join("."));
}
const SKIP = new Set(["node_modules", "dist", "dist-radio", "dist-roulette", "dist-flinder", ".vercel-out", ".git", "__pycache__"]);
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(html|ts|tsx|js)$/.test(name) && !p.startsWith(DIR)) yield p;
  }
}
const USE = [/data-i18n(?:-html)?="([^"]+)"/g, /\bt\(\s*["'`]([a-zA-Z][\w-]*\.[\w.-]+)["'`]/g];
for (const root of ["docs", "world", "flybook/web", "mine/web"]) {
  for (const file of walk(join(REPO, root))) {
    const src = readFileSync(file, "utf8");
    const keys = new Set();
    for (const re of USE) for (const m of src.matchAll(re)) keys.add(m[1]);
    for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const pair of m[1].split(";")) { const k = pair.split(":")[1]?.trim(); if (k) keys.add(k); }
    for (const k of keys) {
      const ns = k.split(".")[0];
      if (!(ns in en)) continue; // not a translation key (e.g. an object path)
      if (!enKeys.has(k)) errors.push(`${relative(REPO, file)}: key "${k}" is not in en/${ns}.json`);
    }
  }
}

for (const w of warnings) console.log(`warn  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
const langs = LANGUAGES.map((l) => l.code).join(", ");
console.log(`${Object.keys(en).length} namespaces, ${Object.values(en).reduce((n, f) => n + Object.keys(f).length, 0)} English strings, languages: ${langs} · ${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);
