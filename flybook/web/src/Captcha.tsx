import { useEffect, useRef } from "react";

/**
 * Cloudflare Turnstile, shown only when VITE_TURNSTILE_SITE_KEY is set. Supabase Auth checks the token when
 * captcha protection is on (Authentication → Attack Protection). Tokens are single use: remount (change `key`)
 * after each sign-in attempt.
 */
export const CAPTCHA_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) || undefined;

type Turnstile = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window { turnstile?: Turnstile }
}

let loading: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { loading = null; reject(new Error("the captcha couldn't load")); };
    document.head.appendChild(s);
  });
  return loading;
}

export default function Captcha({ onToken }: { onToken: (token: string | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!CAPTCHA_KEY) return;
    let id: string | undefined;
    let gone = false;
    onToken(null);
    loadScript()
      .then(() => {
        if (gone || !box.current || !window.turnstile) return;
        id = window.turnstile.render(box.current, {
          sitekey: CAPTCHA_KEY, theme: "dark",
          callback: (token: string) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
        });
      })
      .catch(() => onToken(null));
    return () => {
      gone = true;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, []);
  return CAPTCHA_KEY ? <div ref={box} className="captcha" /> : null;
}
