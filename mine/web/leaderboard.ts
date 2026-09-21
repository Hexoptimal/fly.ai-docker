/**
 * /compute/leaderboard?month=YYYY-MM: wallets by points for a month, the days left, the pool once announced
 * or snapshotted, and the visitor's own row if this browser has a miner with a linked wallet.
 */
import { locale, t } from "./i18n.ts";
import { API } from "./config.ts";
import { compact } from "./format.ts";
import { mountAccount, signedIn } from "./account.ts";
import { api } from "./mine-core.ts";
import { shortAddress } from "./wallet.ts";

const $ = (id: string) => document.getElementById(id)!;
const TOP = 50;
const fmt = (n: number, digits = 1) => n.toLocaleString(locale(), { maximumFractionDigits: digits });

function shiftMonth(m: string, by: number): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1 + by, 1)).toISOString().slice(0, 7);
}

async function load(): Promise<void> {
  const current = new Date().toISOString().slice(0, 7);
  const asked = new URLSearchParams(location.search).get("month");
  const m = asked && /^\d{4}-\d{2}$/.test(asked) ? asked : current;
  const data = await api(API, `/api/month?month=${m}`, null);

  const name = new Date(`${m}-01T00:00:00Z`).toLocaleString(locale(), { month: "long", year: "numeric", timeZone: "UTC" });
  $("title").textContent = m === current ? t("compute.leaderboard.soFar", { month: name }) : name;
  ($("prev") as HTMLAnchorElement).href = `?month=${shiftMonth(m, -1)}`;
  const next = shiftMonth(m, 1);
  ($("next") as HTMLAnchorElement).href = `?month=${next}`;
  $("next").hidden = next > current;

  $("wallets").textContent = String(data.wallets.length);
  $("points").textContent = fmt(data.total_points, 0);
  $("days").textContent = data.closed ? t("compute.leaderboard.ended") : String(data.days_left);
  $("days-label").textContent = data.closed ? new Date(data.ends_at).toLocaleDateString(locale(), { timeZone: "UTC" }) : t("compute.leaderboard.daysLeft");
  const pool = data.snapshot?.pool ?? data.announced_pool;
  $("pool").textContent = pool ? compact(Number(pool)) : t("compute.leaderboard.notSet");
  // before the snapshot the pool is the announcement plus the buyers' part, which grows as orders are charged
  const buyers = Number(data.buyer_pool ?? 0);
  $("pool-parts").hidden = !!data.snapshot || buyers <= 0;
  if (!data.snapshot && buyers > 0) {
    const announced = Number(data.announced_pool ?? 0) - buyers;
    const fromUsdc = Number(data.buyer_pool_from_usdc ?? 0);
    $("pool-parts").textContent = [
      t("compute.leaderboard.poolBuyers", { announced: announced > 0 ? t("compute.leaderboard.poolAnnounced", { amount: compact(announced) }) : "", buyers: compact(buyers) }),
      fromUsdc > 0 ? t("compute.leaderboard.poolUsdc", { amount: compact(fromUsdc), usdc: Number(data.usdc_received).toLocaleString(locale(), { maximumFractionDigits: Number(data.usdc_received) < 1 ? 6 : 2 }) }) : "",
      t("compute.leaderboard.poolGrows"),
    ].join("");
  }

  let mine: string | null = signedIn();
  try {
    const token = localStorage.getItem("flymine.token");
    if (token && !mine) mine = (await api(API, "/api/me", token)).wallet;
  } catch { /* no miner in this browser */ }

  const rows = data.wallets as { rank: number; wallet: string; points: number; share: number }[];
  const me = mine ? rows.find((r) => r.wallet === mine) : undefined;
  $("you").hidden = !mine;
  if (mine) {
    $("you-text").textContent = me
      ? t("compute.leaderboard.you", { rank: me.rank, wallets: rows.length, points: fmt(me.points), share: (me.share * 100).toFixed(2) })
        + (pool ? t("compute.leaderboard.youAtShare", { amount: compact(Number(pool) * me.share) }) : "")
      : t("compute.leaderboard.youNone", { wallet: shortAddress(mine) });
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

mountAccount();
void load();
// the pool grows as buyers' orders are charged: keep this month's numbers current
setInterval(() => { if (!document.hidden) void load().catch(() => {}); }, 60_000);
