import { useEffect, useState } from "react";
import type { Viewer } from "./Account";
import { LEARNERS, StyleEditor, type Style } from "./TradingStyle";
import { db, loadMarket, type Coin, type FlyTrade, type Learning, type MarketControl, type MarketRound, type Trader } from "./feed";

const SIDE: Record<FlyTrade["side"], string> = {
  buy: "bought", panic_sell: "panic-sold", take_profit: "took profit on", sell: "sold", skipped: "almost traded",
};
const WHY: Record<Exclude<FlyTrade["side"], "skipped">, string> = {
  buy: "saw it moving and turned toward it",
  panic_sell: "saw it falling like a looming shape and jumped",
  take_profit: "felt the choppy market like wind and groomed",
  sell: "backed away from it",
};
const WANTED: Record<string, string> = { buy: "buy", panic_sell: "panic-sell", take_profit: "take profit on", sell: "sell" };
const SENSE: Record<string, string> = { target: "pumps (moving flies)", threat: "crashes (looming)", wind: "chop (wind)" };
const ACTION: Record<string, string> = { buy: "buy", panic_sell: "panic sell", take_profit: "take profit", sell: "sell" };
const INHERIT: Record<string, string> = {
  traits: "children get its traits only",
  partial: "children get its traits and part of what it learned",
  all: "children get everything it learned",
};
const learningOf = (t: Trader): Learning => ({ dopamine: true, memory: true, tubes: true, ...(t.learning ?? {}) });
const setupName = (l: Learning) => {
  const on = LEARNERS.filter((x) => l[x.key]).map((x) => x.label.toLowerCase());
  return on.length === 0 ? "no learning" : on.length === LEARNERS.length ? "all learners" : on.join(" + ");
};
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const eth = (x: number) => (x >= 100 ? x.toFixed(0) : x >= 1 ? x.toFixed(3) : x >= 0.001 ? x.toFixed(4) : x.toPrecision(3));
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

function Spark({ values }: { values: number[] }) {
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

/** A 0..max bar with the neutral value (1.0) marked. */
function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  return (
    <div className="mind-bar" title={`${label}: ${value.toFixed(2)}`}>
      <span className="mind-bar-label">{label}</span>
      <span className="mind-bar-track">
        <i style={{ width: `${Math.min(100, (100 * value) / max)}%` }} className={value >= 1 ? "up" : "down"} />
        <b style={{ left: `${100 / max}%` }} />
      </span>
      <span className="mono">{value.toFixed(2)}×</span>
    </div>
  );
}

/** The fly's trading style: its owner can change it, everyone else sees which learners it uses. */
function Learners({ t, mine, onSaved }: { t: Trader; mine: boolean; onSaved: (flyId: string, s: Style) => void }) {
  const l = learningOf(t);
  if (mine) {
    return (
      <div className="learners">
        <h5>Your call: its trading style</h5>
        <StyleEditor flyId={t.fly_id} learning={l} risk={t.traits?.risk ?? null} onSaved={(s) => onSaved(t.fly_id, s)} />
      </div>
    );
  }
  return (
    <div className="learners">
      <h5>Learns with</h5>
      <div className="learner-list">
        {LEARNERS.map((x) => (
          <label key={x.key} className={`learner${l[x.key] ? " on" : ""}`}>
            <input type="checkbox" checked={l[x.key]} disabled readOnly />
            <span><b>{x.label}</b>: {x.note}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** What a trading fly is born with, what it has learned, and who it came from. */
function Mind({ t, names, onFly, mine, onSaved }: {
  t: Trader; names: Map<string, Trader>; onFly: (id: string) => void; mine: boolean; onSaved: (flyId: string, s: Style) => void;
}) {
  const s = t.stats ?? {};
  const tubes = Object.entries(t.tubes ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const parents = (t.fly_parents ?? []).map((id) => names.get(id)).filter((p): p is Trader => !!p);
  return (
    <div className="mind">
      <div className="mind-col">
        <h5>Born with</h5>
        <ul className="mind-traits">
          <li>risks <b>{Math.round((t.traits?.risk ?? 0) * 100)}%</b> of its ETH a buy</li>
          <li>learns at <b>{(t.traits?.lr ?? 0).toFixed(2)}</b> per dopamine hit</li>
          <li>remembers <b>{t.traits?.memory_size ?? "?"}</b> trades, compares <b>{t.traits?.k ?? "?"}</b> similar ones</li>
          <li>tubes grow <b>{(t.traits?.tube_growth ?? 0).toFixed(2)}</b>, wither <b>{Math.round((t.traits?.tube_decay ?? 0) * 100)}%</b> a round</li>
        </ul>
        <p className="fine">{t.inherit ? INHERIT[t.inherit] : ""}{parents.length ? " · child of " : ""}
          {parents.map((p, i) => (
            <span key={p.fly_id}>{i ? " × " : ""}<button className="who inline" onClick={() => onFly(p.fly_id)}>{p.name}</button></span>
          ))}
        </p>
      </div>
      <div className="mind-col">
        <h5>Dopamine has tuned</h5>
        {Object.entries(t.gains ?? {}).map(([k, v]) => <Bar key={k} value={v} max={2.5} label={`notices ${SENSE[k] ?? k}`} />)}
        {Object.entries(t.bias ?? {}).map(([k, v]) => <Bar key={k} value={v} max={2} label={`urge to ${ACTION[k] ?? k}`} />)}
        <p className="fine">last dopamine {(s.dopamine ?? 0) >= 0 ? "+" : ""}{(s.dopamine ?? 0).toFixed(2)} · {s.good_trades ?? 0} good / {s.bad_trades ?? 0} bad trades</p>
      </div>
      <div className="mind-col">
        <h5>Memory and slime tubes</h5>
        <p className="fine">remembers {t.memories ?? 0} trades · stopped itself {s.vetoes ?? 0} times</p>
        {tubes.length === 0 && <p className="fine">No tubes grown yet.</p>}
        {tubes.map(([sym, v]) => <Bar key={sym} value={v} max={5} label={`$${sym}`} />)}
      </div>
      <Learners t={t} mine={mine} onSaved={onSaved} />
    </div>
  );
}

/**
 * The fly market: a SIMULATED market where holders' flies trade fake coins with fake ETH. Every trade is what the
 * fly's real brain did with what the market did to its senses, shaped by what it has learned (worker/market.py, minds.py).
 */
export default function Market({ viewer, onFly }: { viewer: Viewer; onFly: (id: string) => void }) {
  const [coins, setCoins] = useState<Coin[] | null>(null);
  const [rounds, setRounds] = useState<MarketRound[]>([]);
  const [traders, setTraders] = useState<Trader[]>([]);
  const [trades, setTrades] = useState<FlyTrade[]>([]);
  const [mine, setMine] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [control, setControl] = useState<MarketControl | null>(null);

  useEffect(() => {
    const refresh = () => loadMarket().then((m) => {
      setControl(m.control);
      setCoins(m.coins);
      setRounds(m.rounds);
      setTraders(m.traders);
      setTrades(m.trades);
    });
    refresh();
    if (!db) return;
    const channel = db.channel("market")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "market_rounds" }, () => setTimeout(refresh, 1500))
      .subscribe();
    const t = setInterval(refresh, 120_000);
    return () => {
      clearInterval(t);
      void db?.removeChannel(channel);
    };
  }, []);

  const names = new Map(traders.map((t) => [t.fly_id, t]));
  const last = rounds[rounds.length - 1];
  const prev = rounds[rounds.length - 2];
  const board = traders.filter((t) => !mine || t.owner === viewer?.userId);
  const feed = trades.filter((t) => !mine || names.get(t.fly_id)?.owner === viewer?.userId);
  const saved = (flyId: string, s: Style) => setTraders((ts) => ts.map((t) => (t.fly_id !== flyId ? t : {
    ...t, learning: s.learning, traits: s.risk !== null ? { ...(t.traits ?? {}), risk: s.risk } : t.traits,
  })));
  // average result per learner setup, so players can compare choices
  const bySetup = new Map<string, number[]>();
  for (const t of traders) bySetup.set(setupName(learningOf(t)), [...(bySetup.get(setupName(learningOf(t))) ?? []), t.pnl]);
  const setups = [...bySetup].map(([name, p]) => ({ name, flies: p.length, pnl: p.reduce((a, b) => a + b, 0) / p.length }))
    .sort((a, b) => b.pnl - a.pnl);

  return (
    <div className="market">
      <div className="feed-head">
        <h2>Fly market</h2>
        <p>Holders' flies trade with their real brains, and learn. A pumping coin looks like a fly walking past, a crashing one
          like a looming shape; what the fly's neurons do becomes the trade. Profit is dopamine: it tunes what the fly notices
          and wants, its memory stops trades that hurt before, and slime-mold tubes pull it back to coins that paid. Children
          inherit it. Owners set each fly's trading style (risk and learners) when they hatch or breed it, in My flies, or in its 🧠 mind.</p>
      </div>
      <p className="market-warning">Simulated. Fake coins, fake prices, fake ETH. Not real trading and not advice.</p>
      {control?.paused && (
        <p className="market-paused">⏸ Training paused{control.note ? `: ${control.note}` : ""}. No trades or learning until it resumes; every fly
          keeps its portfolio, memories and tubes.</p>
      )}
      <details className="card learning-check">
        <summary>Does learning make them better traders? No, not yet.</summary>
        <p>We ran the same 12 flies on the same 3 simulated markets for 40 rounds each, learning and not learning. Flies that
          learned ended with <b>0.76 fake ETH</b> on average against <b>1.19</b> for identical flies that didn't. Memory did
          most of the damage: flies remembered a few unlucky trades and stopped trading, missing a market that doubled.</p>
        <p>We fixed that (each trade judged by its own coin 3 rounds later, a much less jumpy memory) and tested again on
          new markets. Learning flies still lost: <b>1.11 fake ETH</b> against <b>1.37</b> for flies that didn't learn, and
          only 10 of 36 beat their non-learning twin. Dopamine and memory each cost money on their own. Slime-mold tubes
          were neutral in both tests (1.43 vs 1.37, no real difference).</p>
      </details>

      {coins === null && <div className="empty">Opening the market…</div>}
      {coins !== null && coins.length === 0 && <div className="empty">The market opens with the next round.</div>}

      {coins !== null && coins.length > 0 && (
        <>
          <div className="coins">
            {coins.map((c) => {
              const series = rounds.map((r) => r.prices[c.symbol]).filter((v): v is number => typeof v === "number");
              const move = last && prev && prev.prices[c.symbol] ? last.prices[c.symbol] / prev.prices[c.symbol] - 1 : 0;
              return (
                <div key={c.symbol} className="coin card">
                  <div className="coin-top">
                    <b>${c.symbol}</b>
                    <span className={`badge${c.kind === "meme" ? " meme" : ""}`}>{c.kind === "meme" ? "meme" : "sim"}</span>
                  </div>
                  <span className="fine">{c.name}</span>
                  <span className="mono coin-price">{eth(c.price)} ETH</span>
                  <span className={`mono ${move >= 0 ? "up" : "down"}`}>{pct(move)}{c.regime !== "calm" ? ` · ${c.regime}` : ""}</span>
                  <Spark values={series} />
                </div>
              );
            })}
          </div>
          {last?.events?.length ? (
            <p className="fine">Last round: {last.events.map((e) => `$${e.symbol} ${e.kind === "rug" ? "got rugged" : "pumped"} ${pct(e.move)}`).join(", ")}</p>
          ) : null}

          <div className="board-controls">
            <div className="seg">
              <button className={!mine ? "on" : ""} onClick={() => setMine(false)}>All traders</button>
              <button className={mine ? "on" : ""} onClick={() => setMine(true)} disabled={!viewer}>My flies</button>
            </div>
          </div>
          {setups.length > 1 && (
            <p className="fine setups">By setup (average, small groups are mostly luck):{" "}
              {setups.map((s) => `${s.name} ${pct(s.pnl)} (${s.flies} ${s.flies === 1 ? "fly" : "flies"})`).join(" · ")}</p>
          )}

          <div className="market-grid">
            <section>
              <h4>Fly traders</h4>
              {board.length === 0 && <div className="empty">No trading flies yet. Holders' flies start with 1 fake ETH.</div>}
              <ol className="ranking traders">
                {board.map((t, i) => (
                  <li key={t.fly_id} className={`${viewer && t.owner === viewer.userId ? "me" : ""}${open === t.fly_id ? " open" : ""}`}>
                    <span className={`rank${i < 3 ? ` top${i + 1}` : ""}`}>{i + 1}</span>
                    <button className="who" onClick={() => onFly(t.fly_id)}>
                      <span className="dot" style={{ background: t.color }} />{t.name}
                    </button>
                    {(t.generation ?? 1) > 1 && <span className="badge">gen {t.generation}</span>}
                    <span className="stat">{eth(t.value_eth)} ETH</span>
                    <span className={`sub mono ${t.pnl >= 0 ? "up" : "down"}`}>
                      {pct(t.pnl)} · {t.trades} trades · {setupName(learningOf(t))} · holds {Object.keys(t.holdings ?? {}).map((s) => `$${s}`).join(" ") || "only ETH"}
                    </span>
                    <button className="more mind-toggle" onClick={() => setOpen(open === t.fly_id ? null : t.fly_id)} aria-expanded={open === t.fly_id}>
                      {open === t.fly_id ? "hide mind" : "🧠 mind"}
                    </button>
                    {open === t.fly_id && <Mind t={t} names={names} onFly={onFly} mine={!!viewer && t.owner === viewer.userId} onSaved={saved} />}
                  </li>
                ))}
              </ol>
            </section>
            <section>
              <h4>Trades</h4>
              {feed.length === 0 && <div className="empty">No trades yet.</div>}
              <ul className="trades">
                {feed.map((t) => {
                  const fly = names.get(t.fly_id);
                  const dop = t.reason.dopamine ?? 0;
                  return (
                    <li key={t.id} className={t.side === "skipped" ? "skipped" : ""}>
                      <button className="who inline" onClick={() => onFly(t.fly_id)}>
                        <span className="dot" style={{ background: fly?.color ?? "#888" }} />{fly?.name ?? "a fly"}
                      </button>{" "}
                      {t.side === "skipped"
                        ? <>wanted to {WANTED[t.reason.wanted ?? ""] ?? "trade"} <b>${t.symbol}</b> but didn't</>
                        : <>{SIDE[t.side]} <b>${t.symbol}</b> for {eth(t.eth)} ETH</>}
                      <span className="when">{ago(t.created_at)}</span>
                      <p className="fine">
                        {t.side === "skipped" ? `${t.reason.skipped ?? "its learning stopped it"}.` : `It ${WHY[t.side]}.`}
                        {" "}Neurons: {(t.reason.did ?? []).join(", ") || "none"}.
                        {t.reason.memory ? ` Memory: ${t.reason.memory.similar} similar trades, ${pct(t.reason.memory.mean_reward)} on average.` : ""}
                        {t.side !== "skipped" ? ` Worth ${eth(t.value_after)} ETH after.` : ""}
                      </p>
                      {dop !== 0 && <span className={`chip ${dop > 0 ? "up" : "down"}`}>dopamine {dop > 0 ? "+" : ""}{dop.toFixed(2)}</span>}
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
