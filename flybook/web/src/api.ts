import { db, type FlySettings, type Learning, type Meme } from "./feed";

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
export type Config = {
  token: string; chain_id: number; min_tokens: number; max_flies: number; free_max_flies: number; settings: Spec;
  merch?: { fee_tokens: number; share: number };
};

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
export const createFly = (fly: FlySettings & { name: string; color: string; patch_id: string; style?: StyleBody }) =>
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
export const breedFly = (req: { parent_a: string; parent_b: string; name: string; color: string; patch_id: string; style?: StyleBody }) =>
  call<MyFly>("/breed", { method: "POST", body: JSON.stringify(req) });

/** A fly's trading style in the fly market: which learners it uses, and how much of its fake ETH goes into a buy. */
export type StyleBody = { learning?: Learning; risk?: number };
/** Owner only: change it from the next market round. */
export const setStyle = (flyId: string, style: StyleBody) =>
  call<{ fly_id: string } & StyleBody>("/market/style", { method: "POST", body: JSON.stringify({ fly_id: flyId, ...style }) });

export type MemeQuota = {
  holder: boolean; used_today: number; left_today: number; global_left: number; idea_max: number;
  styles: { key: string; label: string }[];
};
export const getMemeQuota = () => call<MemeQuota>("/memes/quota");
export const makeMeme = (req: { post_id: number; style: string; idea?: string }) =>
  call<Meme & { url: string }>("/memes", { method: "POST", body: JSON.stringify(req) });
export const deleteMeme = (id: number) => call<{ deleted: number }>(`/memes/${id}`, { method: "DELETE" });
export const setMemeLike = (id: number, liked: boolean) =>
  call<{ meme_id: number; liked: boolean; likes: number }>(`/memes/${id}/like`, { method: liked ? "POST" : "DELETE" });
export const reportMeme = (id: number, reason: string) =>
  call<{ reported: boolean }>(`/memes/${id}/report`, { method: "POST", body: JSON.stringify({ reason }) });

/** Fly merch (worker/merch.py): draw a design of your fly, pay the $FLYAI fee, it goes on sale in the shop. */
export type MerchQuota = {
  holder: boolean; wallet: string | null; left_today: number; per_day: number; global_left: number; idea_max: number;
  fee_tokens: number; fee_wei: string; treasury: `0x${string}`; share: number;
  styles: { key: string; label: string }[]; products: { kind: string; label: string }[];
};
export type MerchProduct = { kind: string; url: string | null; image_url: string | null; price: number | null };
export type MerchDesign = {
  id: number; fly_id: string; style: string; idea: string | null; preview_url: string;
  status: "draft" | "paid" | "making" | "live" | "failed" | "removed"; error?: string | null;
  created_at: string; live_at?: string | null; merch_products?: MerchProduct[]; sold?: number; earned?: number;
  name_printed?: boolean;
};
export type MyMerch = {
  designs: MerchDesign[]; earned: number; paid: number; unpaid: number; share: number;
  payouts: { id: number; usd: number; tokens: number | null; tx_hash: string | null; paid_at: string }[];
};
export const getMerchQuota = () => call<MerchQuota>("/merch/quota");
export const getMyMerch = () => call<MyMerch>("/merch/mine");
export const drawDesign = (req: { fly_id: string; style: string; idea?: string; show_name: boolean }) =>
  call<MerchDesign>("/merch/designs", { method: "POST", body: JSON.stringify(req) });
export const payDesign = (id: number, txHash: string) =>
  call<{ id: number; status: string }>(`/merch/designs/${id}/pay`, { method: "POST", body: JSON.stringify({ tx_hash: txHash }) });
export const deleteDesign = (id: number) => call<{ deleted: number }>(`/merch/designs/${id}`, { method: "DELETE" });
