import { db, type FlySettings } from "./feed";

/** The Flybook API on fly.io (flybook/worker/api.py): accounts, flies and everything people do. */
export const API = (import.meta.env.VITE_FLYBOOK_API as string | undefined) ?? "https://flybook-worker.fly.dev";

export type MyFly = FlySettings & {
  id: string; name: string; color: string; patch_id: string; active: boolean; created_at: string;
  elo?: number; wins?: number; losses?: number; draws?: number; generation?: number; parents?: string[];
  auto_born?: boolean;   // born from automatic mating; doesn't count toward max_flies
};
export type Me = {
  wallet: string | null;         // null for an email account
  email: string | null;          // only for email accounts, only to yourself
  handle: string | null;         // public name; accounts without a wallet need one before they play
  balance: string; tokens: number; holder: boolean; min_tokens: number;
  max_flies: number;             // your limit: holder_max_flies for holders, free_max_flies otherwise
  holder_max_flies: number; free_max_flies: number; flies: MyFly[];
};

type Item = { key: string; label: string; help: string };
export type Spec = {
  senses: Item[];
  sense_range: [number, number];
  temperament: (Item & { min: number; max: number })[];
  dials: Item[];
  dial_levels: string[];
  presets: (Item & { settings: Partial<FlySettings> })[];
};
export type Config = { token: string; chain_id: number; min_tokens: number; max_flies: number; free_max_flies: number; settings: Spec };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = db ? (await db.auth.getSession()).data.session : null;
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body as T;
}

export const getConfig = () => call<Config>("/config");
export type PublicBalance = { wallet: string; balance: string; tokens: number; holder: boolean };
/** A wallet's $FLYAI balance read by the API, for when the browser can't reach the chain RPC. */
export const getBalance = (wallet: string) => call<PublicBalance>(`/balance/${wallet}`);
export const getMe = () => call<Me>("/me");
export const setHandle = (handle: string) => call<{ handle: string }>("/handle", { method: "POST", body: JSON.stringify({ handle }) });
export const createFly = (fly: FlySettings & { name: string; color: string; patch_id: string }) =>
  call<MyFly>("/flies", { method: "POST", body: JSON.stringify(fly) });
export type LikeResult = { post_id: number; liked: boolean; likes: number };
export const setLike = (postId: number, liked: boolean) =>
  call<LikeResult>(`/posts/${postId}/like`, { method: liked ? "POST" : "DELETE" });
export const pokePatch = (patchId: string, stimulus: string, x?: number, y?: number) =>
  call<{ id: number }>("/pokes", { method: "POST", body: JSON.stringify({ patch_id: patchId, stimulus, x, y }) });
export const setCaption = (postId: number, body: string | null) =>
  call<{ post_id: number; caption: string | null }>(`/posts/${postId}/caption`,
    body === null ? { method: "DELETE" } : { method: "POST", body: JSON.stringify({ body }) });
export const addComment = (postId: number, body: string) =>
  call<{ id: number }>(`/posts/${postId}/comments`, { method: "POST", body: JSON.stringify({ body }) });
export const deleteComment = (id: number) => call<{ deleted: number }>(`/comments/${id}`, { method: "DELETE" });
export const challengeFly = (flyId: string, opponentId: string) =>
  call<{ id: number }>("/duels", { method: "POST", body: JSON.stringify({ fly_id: flyId, opponent_id: opponentId }) });
export const breedFly = (req: { parent_a: string; parent_b: string; name: string; color: string; patch_id: string }) =>
  call<MyFly>("/breed", { method: "POST", body: JSON.stringify(req) });
