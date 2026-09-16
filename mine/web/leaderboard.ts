/**
 * /compute/leaderboard?month=YYYY-MM: wallets by points for a month, the days left, the pool once announced
 * or snapshotted, and the visitor's own row if this browser has a miner with a linked wallet.
 */
import { API } from "./config.ts";
import { api } from "./mine-core.ts";
import { shortAddress } from "./wallet.ts";

const $ = (id: string) => document.getElementById(id)!;
const TOP = 50;
const fmt = (n: number, digits = 1) => n.toLocaleString("en-US", { maximumFractionDigits: digits });

function shiftMonth(m: string, by: number): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1 + by, 1)).toISOString().slice(0, 7);
}

async function load(): Promise<void> {
  const current = new Date().toISOString().slice(0, 7);
  const asked = new URLSearchParams(location.search).get("month");
  const m = asked && /^\d{4}-\d{2}$/.test(asked) ? asked : current;
  const data = await api(API, `/api/month?month=${m}`, null);

  const name = new Date(`${m}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  $("title").textContent = m === current ? `${name}, so far` : name;
  ($("prev") as HTMLAnchorElement).href = `?month=${shiftMonth(m, -1)}`;
  const next = shiftMonth(m, 1);
  ($("next") as HTMLAnchorElement).href = `?month=${next}`;
  $("next").hidden = next > current;

  $("wallets").textContent = String(data.wallets.length);
  $("points").textContent = fmt(data.total_points, 0);
  $("days").textContent = data.closed ? "ended" : String(data.days_left);
  $("days-label").textContent = data.closed ? new Date(data.ends_at).toLocaleDateString("en-US", { timeZone: "UTC" }) : "days left";
  const pool = data.snapshot?.pool ?? data.announced_pool;
  $("pool").textContent = pool ? fmt(Number(pool), 0) : "not set";

  let mine: string | null = null;
  try {
    const token = localStorage.getItem("flymine.token");
    if (token) mine = (await api(API, "/api/me", token)).wallet;
  } catch { /* no miner in this browser */ }

  const rows = data.wallets as { rank: number; wallet: string; points: number; share: number }[];
  const me = mine ? rows.find((r) => r.wallet === mine) : undefined;
  $("you").hidden = !mine;
  if (mine) {
    $("you-text").textContent = me
      ? `You: #${me.rank} of ${rows.length} · ${fmt(me.points)} points · ${(me.share * 100).toFixed(2)}%${pool ? ` · ≈ ${fmt(Number(pool) * me.share, 0)} $FLYAI at this share` : ""}`
      : `You: ${shortAddress(mine)} has no points this month yet`;
  }

  const shown = rows.slice(0, TOP);
  if (me && me.rank > TOP) shown.push(me);
  $("empty").hidden = shown.length > 0;
  $("board").replaceChildren(...shown.map((r) => {
    const tr = document.createElement("tr");
    if (r.wallet === mine) tr.className = "me";
    for (const [text, cls, title] of [[`#${r.rank}`, "", ""], [shortAddress(r.wallet), "", r.wallet], [fmt(r.points), "r", ""], [`${(r.share * 100).toFixed(2)}%`, "r", ""]]) {
      const td = document.createElement("td");
      td.textContent = text;
      if (cls) td.className = cls;
      if (title) td.title = title;
      tr.append(td);
    }
    return tr;
  }));
}

void load();
