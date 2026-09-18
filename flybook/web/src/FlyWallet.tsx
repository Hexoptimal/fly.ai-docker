import { useEffect, useState } from "react";
import { loadWallet, type FlyTrade, type Wallet as WalletData } from "./feed";

export const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
/** Paper dollars (the market's cash is paper USDG since 2026-09-18; the columns are still named eth). */
export const cash = (x: number) => {
  const a = Math.abs(x);
  const body = a < 1e-12 ? "0" : a >= 1000 ? a.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : a >= 1 ? a.toFixed(2) : a >= 0.01 ? a.toFixed(4) : a.toPrecision(3);
  return `${x < 0 ? "−" : ""}$${body}`;
};
const signedCash = (x: number) => `${x >= 0 ? "+" : ""}${cash(x)}`;
const amount = (x: number) => (x >= 1000 ? x.toFixed(0) : x >= 1 ? x.toFixed(2) : x.toPrecision(3));
export const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

export function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <svg className="spark" viewBox="0 0 100 28" />;
  const lo = Math.min(...values), hi = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${hi > lo ? 26 - ((v - lo) / (hi - lo)) * 24 : 14}`).join(" ");
  const up = values[values.length - 1] >= values[0];
  return (
    <svg className="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={up ? "#3ddc84" : "#ff5b4f"} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const DID: Record<Exclude<FlyTrade["side"], "skipped">, string> = {
  buy: "Bought", panic_sell: "Panic-sold", take_profit: "Took profit on", sell: "Sold",
  launch: "Launched", buyback: "Bought back", dump: "Dumped",
};

/** One fly's paper wallet: what it's worth, its cash, each token it holds, its value over time and its own trades. */
export default function Wallet({ flyId, refresh }: { flyId: string; refresh?: number }) {
  const [w, setW] = useState<WalletData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadWallet(flyId).then((x) => { setW(x); setError(null); }).catch((e) => setError(e?.message ?? String(e)));
  }, [flyId, refresh]);

  if (error) return <p className="err">{error}</p>;
  if (!w) return <p className="fine">Opening its wallet…</p>;
  if (!w.portfolio) {
    return <p className="fine wallet-empty">Wallet opening: every fly gets 1 ETH's worth of paper USDG within a few minutes.</p>;
  }

  const p = w.portfolio;
  const coins = Object.entries(p.holdings ?? {}).filter(([, h]) => h.qty > 0).map(([symbol, h]) => {
    const now = w.prices[symbol] !== undefined ? h.qty * w.prices[symbol] : null;
    return { symbol, qty: h.qty, paid: h.cost_eth, now };
  }).sort((a, b) => (b.now ?? 0) - (a.now ?? 0));
  const inCoins = coins.reduce((sum, c) => sum + (c.now ?? 0), 0);
  const total = p.eth + inCoins;
  const made = p.start_eth > 0 ? total / p.start_eth - 1 : 0;
  const trades = w.trades.filter((t): t is FlyTrade & { side: keyof typeof DID } => t.side !== "skipped");
  const history = [...(w.complete ? [p.start_eth] : []), ...[...trades].reverse().map((t) => t.value_after), total];

  return (
    <div className="wallet">
      <div className="wallet-top">
        <div>
          <span className="fine">Worth now</span>
          <b className="mono wallet-total">{cash(total)}</b>
          <span className={`mono ${made >= 0 ? "up" : "down"}`}>{pct(made)} from {cash(p.start_eth)}</span>
        </div>
        <div><span className="fine">Cash</span><b className="mono">{cash(p.eth)}</b></div>
        <div><span className="fine">In tokens</span><b className="mono">{cash(inCoins)}</b></div>
        <div><span className="fine">Trades</span><b className="mono">{p.trades}</b></div>
      </div>

      {history.length >= 3 && (
        <div className="wallet-chart">
          <Spark values={history} />
          <span className="fine">What it was worth after each trade{w.complete ? ", from the start" : ""}, up to now</span>
        </div>
      )}

      <h5>Tokens it holds</h5>
      {coins.length === 0 ? <p className="fine">None, only cash right now.</p> : (
        <div className="wallet-table-wrap">
          <table className="wallet-table">
            <thead><tr><th>Token</th><th>Amount</th><th>Paid</th><th>Worth now</th><th>Profit / loss</th></tr></thead>
            <tbody>
              {coins.map((c) => (
                <tr key={c.symbol}>
                  <td><b>${c.symbol}</b></td>
                  <td className="mono">{amount(c.qty)}</td>
                  <td className="mono">{cash(c.paid)}</td>
                  <td className="mono">{c.now === null ? "?" : cash(c.now)}</td>
                  <td className={`mono ${c.now !== null && c.now >= c.paid ? "up" : "down"}`}>
                    {c.now === null || c.paid <= 0 ? "–" : `${pct(c.now / c.paid - 1)} (${signedCash(c.now - c.paid)})`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h5>Its last trades</h5>
      {trades.length === 0 ? <p className="fine">No trades yet.</p> : (
        <ul className="wallet-trades">
          {trades.slice(0, 8).map((t) => (
            <li key={t.id}>
              <span>{DID[t.side]} <b>${t.symbol}</b></span>
              {["buy", "launch", "buyback"].includes(t.side)
                ? <span className="mono">paid {cash(t.eth)}</span>
                : <span className="mono up">got {cash(t.eth)}</span>}
              <span className="fine mono">worth {cash(t.value_after)} after</span>
              <span className="when">{ago(t.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
