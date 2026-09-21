// Types for i18n.js, for the TypeScript apps that bundle it (world/, flybook/web/, mine/web/).

export interface Language { code: string; name: string }
/** a namespace file: nested objects of strings; arrays are word lists read by index ("flinder.profile.jobs.3") */
export type Strings = { [key: string]: string | string[] | Strings | Strings[] };
export type Vars = Record<string, string | number>;

export const LANGUAGES: Language[];
export const DEFAULT_LANG: "en";
export function detectLang(): string;
export function getLang(): string;
export function setLang(code: string): void;
export function init(opts?: { ns?: string[]; bundled?: Record<string, Strings>; base?: string }): Promise<string>;
export function has(key: string): boolean;
export function t(key: string, vars?: Vars): string;
export function locale(): string;
export function translateDOM(root?: ParentNode & Partial<Element>): void;
export function translateNav(nav?: Element | null): void;
export function translateFooter(footer?: Element | null): void;
export function languagePicker(host?: Element | null): HTMLSelectElement;
export function mountNavPicker(nav?: Element | null): void;
export function reveal(): void;
export function setupPage(opts?: { ns?: string[]; bundled?: Record<string, Strings>; base?: string }): Promise<typeof t>;
