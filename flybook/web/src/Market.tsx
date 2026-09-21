import { useEffect, useState } from "react";
import type { Viewer } from "./Account";
import { LEARNERS, StyleEditor, type Style } from "./TradingStyle";
import Wallet, { Spark, ago, cash, pct } from "./FlyWallet";
import { Drama, FlyCoins } from "./FlyCoins";
import {
  db, loadMarket, type Coin, type FlyCoin, type FlyTrade, type Learning, type MarketControl, type MarketRound, type MarketSocial, type SocialHit,
  type Trader,
} from "./feed";
import { Html, t, t as translate, tAt, tOr, tn } from "./i18n";

// flybook.market.side / why / wanted / sense / action / inherit, by the server's key
const SIDE = (side: string) => tAt("flybook.market.side", side);
const WHY = (side: string) => tAt("flybook.market.why", side);
const WANTED = (side: string) => tOr(`flybook.market.wanted.${side}`, t("flybook.market.wanted.trade"));
const SENSE = (k: string) => tOr(`flybook.market.sense.${k}`, k);
const ACTION = (k: string) => tOr(`flybook.market.action.${k}`, k);
const learningOf = (tr: Trader): Learning => ({ dopamine: true, memory: true, tubes: true, ...(tr.learning ?? {}) });
const setupName = (l: Learning) => {
  const on = LEARNERS.filter((x) => l[x.key]).map((x) => tAt("flybook.style.learners", x.key, "label").toLowerCase());
  return on.length === 0 ? t("flybook.market.noLearning") : on.length === LEARNERS.length ? t("flybook.market.allLearners") : on.join(" + ");
};
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
        <h5>{translate("flybook.market.yourCall")}</h5>
        <StyleEditor flyId={t.fly_id} learning={l} risk={t.traits?.risk ?? null} onSaved={(s) => onSaved(t.fly_id, s)} />
      </div>
    );
  }
  return (
    <div className="learners">
      <h5>{translate("flybook.market.learnsWith")}</h5>
      <div className="learner-list">
        {LEARNERS.map((x) => (
          <label key={x.key} className={`learner${l[x.key] ? " on" : ""}`}>
            <input type="checkbox" checked={l[x.key]} disabled readOnly />
            <span><b>{tAt("flybook.style.learners", x.key, "label")}</b>: {tAt("flybook.style.learners", x.key, "note")}</span>
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
  const tr = translate;
  const s = t.stats ?? {};
  const tubes = Object.entries(t.tubes ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const parents = (t.fly_parents ?? []).map((id) => names.get(id)).filter((p): p is Trader => !!p);
  return (
    <div className="mind">
      <div className="mind-col">
        <h5>{tr("flybook.market.bornWith")}</h5>
        <ul className="mind-traits">
          <Html as="li" k="flybook.market.risks" vars={{ pct: Math.round((t.traits?.risk ?? 0) * 100) }} />
          <Html as="li" k="flybook.market.learnsAt" vars={{ lr: (t.traits?.lr ?? 0).toFixed(2) }} />
          <Html as="li" k="flybook.market.remembers" vars={{ size: t.traits?.memory_size ?? "?", k: t.traits?.k ?? "?" }} />
          <Html as="li" k="flybook.market.tubesGrow" vars={{ grow: (t.traits?.tube_growth ?? 0).toFixed(2), decay: Math.round((t.traits?.tube_decay ?? 0) * 100) }} />
        </ul>
        <p className="fine">{t.inherit ? tOr(`flybook.market.inherit.${t.inherit}`, t.inherit) : ""}{parents.length ? tr("flybook.market.childOf") : ""}
          {parents.map((p, i) => (
            <span key={p.fly_id}>{i ? " × " : ""}<button className="who inline" onClick={() => onFly(p.fly_id)}>{p.name}</button></span>
          ))}
        </p>
      </div>
      <div className="mind-col">
        <h5>{tr("flybook.market.dopamineTuned")}</h5>
        {Object.entries(t.gains ?? {}).map(([k, v]) => <Bar key={k} value={v} max={2.5} label={tr("flybook.market.notices", { what: SENSE(k) })} />)}
        {Object.entries(t.bias ?? {}).map(([k, v]) => <Bar key={k} value={v} max={2} label={tr("flybook.market.urgeTo", { what: ACTION(k) })} />)}
        <p className="fine">{tr("flybook.market.lastDopamine", { d: `${(s.dopamine ?? 0) >= 0 ? "+" : ""}${(s.dopamine ?? 0).toFixed(2)}`, good: s.good_trades ?? 0, bad: s.bad_trades ?? 0 })}</p>
      </div>
      <div className="mind-col">
        <h5>{tr("flybook.market.memoryTubes")}</h5>
        <p className="fine">{tr("flybook.market.memoryLine", { n: t.memories ?? 0, vetoes: s.vetoes ?? 0 })}</p>
        {tubes.length === 0 && <p className="fine">{tr("flybook.market.noTubes")}</p>}
        {tubes.map(([sym, v]) => <Bar key={sym} value={v} max={5} label={`$${sym}`} />)}
      </div>
      <Learners t={t} mine={mine} onSaved={onSaved} />
    </div>
  );
}

/**
 * The fly market: holders' flies paper-trade real Robinhood Chain tokens at live prices with paper USDG (nothing is
 * bought on chain). Every trade is what the fly's real brain did with what the market did to its senses, shaped by
 * what it has learned (worker/market.py, prices.py, minds.py).
 */
export default function Market({ viewer, onFly }: { viewer: Viewer; onFly: (id: string) => void }) {
  const [coins, setCoins] = useState<Coin[] | null>(null);
  const [rounds, setRounds] = useState<MarketRound[]>([]);
  const [traders, setTraders] = useState<Trader[]>([]);
  const [trades, setTrades] = useState<FlyTrade[]>([]);
  const [mine, setMine] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [control, setControl] = useState<MarketControl | null>(null);
  const [flyCoins, setFlyCoins] = useState<FlyCoin[]>([]);
  const [social, setSocial] = useState<MarketSocial[]>([]);

  useEffect(() => {
    const refresh = () => loadMarket().then((m) => {
      setControl(m.control);
      setFlyCoins(m.flyCoins);
      setSocial(m.social);
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
  const hyped = (hits?: SocialHit[], fromPosts = false) => [...new Set((hits ?? []).filter((h) => (h.kind === "post") === fromPosts)
    .map((h) => names.get(h.from ?? "")?.name).filter(Boolean))].join(t("flybook.market.and"));
  // why the feed moved a trade: other flies setting it off in the patch, and its own posts since last round
  const fromFeed = (tr: FlyTrade) => {
    const f = tr.reason.felt;
    const bits: string[] = [];
    if (tr.side === "buy" && hyped(f?.target?.social, true)) bits.push(t("flybook.market.caughtEye", { names: hyped(f?.target?.social, true) }));
    if (tr.side === "panic_sell" && hyped(f?.threat?.social, true)) bits.push(t("flybook.market.startled", { names: hyped(f?.threat?.social, true) }));
    if (tr.side === "panic_sell" && f?.threat?.mood) bits.push(t("flybook.market.stillJumpy"));
    if (tr.side === "buy" && f?.target?.mood) bits.push(t("flybook.market.curious"));
    if (tr.side === "take_profit" && f?.wind?.mood) bits.push(t("flybook.market.twitchy"));
    return bits.length ? ` ${bits.join(" ")}` : "";
  };
  const mineSocial = social.filter((e) => !mine || names.get(e.fly_id ?? "")?.owner === viewer?.userId);
  const last = rounds[rounds.length - 1];
  const prev = rounds[rounds.length - 2];
  const board = traders.filter((t) => !mine || t.owner === viewer?.userId);
  const feed = trades.filter((t) => !mine || names.get(t.fly_id)?.owner === viewer?.userId);
  const saved = (flyId: string, s: Style) => setTraders((ts) => ts.map((x) => (x.fly_id !== flyId ? x : {
    ...x, learning: s.learning, traits: s.risk !== null ? { ...(x.traits ?? {}), risk: s.risk } : x.traits,
  })));
  // average result per learner setup, so players can compare choices
  const bySetup = new Map<string, number[]>();
  for (const x of traders) bySetup.set(setupName(learningOf(x)), [...(bySetup.get(setupName(learningOf(x))) ?? []), x.pnl]);
  const setups = [...bySetup].map(([name, p]) => ({ name, flies: p.length, pnl: p.reduce((a, b) => a + b, 0) / p.length }))
    .sort((a, b) => b.pnl - a.pnl);

  return (
    <div className="market">
      <div className="feed-head">
        <h2>{t("flybook.market.title")}</h2>
        <p>{t("flybook.market.intro")}</p>
      </div>
      <p className="market-warning">{t("flybook.market.warning")}</p>
      {control?.paused && (
        <p className="market-paused">{t("flybook.market.paused", { note: control.note ? `: ${control.note}` : "" })}</p>
      )}

      {coins === null && <div className="empty">{t("flybook.market.opening")}</div>}
      {coins !== null && coins.length === 0 && <div className="empty">{t("flybook.market.opensNext")}</div>}

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
                    <span className={`badge${c.category === "meme" ? " meme" : ""}`}>{c.category ? tOr(`flybook.market.category.${c.category}`, c.category) : t(c.kind === "meme" ? "flybook.market.meme" : "flybook.market.sim")}</span>
                  </div>
                  <span className="fine">{c.name}</span>
                  <span className="mono coin-price">{cash(c.price)}</span>
                  <span className={`mono ${move >= 0 ? "up" : "down"}`}>{pct(move)}{c.regime !== "calm" ? ` · ${c.regime}` : ""}</span>
                  <Spark values={series} />
                </div>
              );
            })}
          </div>
          {last?.events?.length ? (
            <p className="fine">{t("flybook.market.lastRound", { events: last.events.map((e) => `$${e.symbol} ${
              e.kind === "launch" ? t("flybook.market.ev.launch") : e.kind === "died" ? t("flybook.market.ev.died")
                : e.kind === "likes" ? t("flybook.market.ev.likes", { move: pct(e.move), likes: e.likes ?? 0, comments: e.comments ?? 0 })
                : t(e.kind === "rug" ? "flybook.market.ev.rug" : e.kind === "dump" ? "flybook.market.ev.dump" : "flybook.market.ev.pump", { move: pct(e.move) })}`).join(", ") })}</p>
          ) : null}
          <FlyCoins coins={flyCoins} onFly={onFly} />

          <div className="board-controls">
            <div className="seg">
              <button className={!mine ? "on" : ""} onClick={() => setMine(false)}>{t("flybook.market.allTraders")}</button>
              <button className={mine ? "on" : ""} onClick={() => setMine(true)} disabled={!viewer}>{t("flybook.market.myFlies")}</button>
            </div>
          </div>
          {setups.length > 1 && (
            <p className="fine setups">{t("flybook.market.bySetup")}
              {setups.map((s) => t("flybook.market.setupLine", { name: s.name, pnl: pct(s.pnl), count: s.flies })).join(" · ")}</p>
          )}

          <div className="market-grid">
            <section>
              <h4>{t("flybook.market.traders")}</h4>
              {board.length === 0 && <div className="empty">{t("flybook.market.noTraders")}</div>}
              <ol className="ranking traders">
                {board.map((x, i) => (
                  <li key={x.fly_id} className={`${viewer && x.owner === viewer.userId ? "me" : ""}${open === x.fly_id ? " open" : ""}`}>
                    <span className={`rank${i < 3 ? ` top${i + 1}` : ""}`}>{i + 1}</span>
                    <button className="who" onClick={() => onFly(x.fly_id)}>
                      <span className="dot" style={{ background: x.color }} />{x.name}
                    </button>
                    {(x.generation ?? 1) > 1 && <span className="badge">{t("flybook.market.gen", { n: x.generation ?? 1 })}</span>}
                    <span className="stat">{cash(x.value_eth)}</span>
                    <span className={`sub mono ${x.pnl >= 0 ? "up" : "down"}`}>
                      {t("flybook.market.traderLine", { pnl: pct(x.pnl), trades: x.trades, setup: setupName(learningOf(x)),
                        holds: Object.keys(x.holdings ?? {}).map((s) => `$${s}`).join(" ") || t("flybook.market.onlyCash") })}
                    </span>
                    <button className="more mind-toggle" onClick={() => setWallet(wallet === x.fly_id ? null : x.fly_id)} aria-expanded={wallet === x.fly_id}>
                      {t(wallet === x.fly_id ? "flybook.market.hideWallet" : "flybook.market.wallet")}
                    </button>
                    <button className="more" onClick={() => setOpen(open === x.fly_id ? null : x.fly_id)} aria-expanded={open === x.fly_id}>
                      {t(open === x.fly_id ? "flybook.market.hideMind" : "flybook.market.mind")}
                    </button>
                    {wallet === x.fly_id && <Wallet flyId={x.fly_id} refresh={last?.id} />}
                    {open === x.fly_id && <Mind t={x} names={names} onFly={onFly} mine={!!viewer && x.owner === viewer.userId} onSaved={saved} />}
                  </li>
                ))}
              </ol>
            </section>
            <Drama social={mineSocial} traders={names} coins={flyCoins} onFly={onFly} />
            <section>
              <h4>{t("flybook.market.trades")}</h4>
              {feed.length === 0 && <div className="empty">{t("flybook.market.noTrades")}</div>}
              <ul className="trades">
                {feed.map((x) => {
                  const fly = names.get(x.fly_id);
                  const dop = x.reason.dopamine ?? 0;
                  const coin = <b>${x.symbol}</b>;
                  return (
                    <li key={x.id} className={x.side === "skipped" ? "skipped" : ""}>
                      <button className="who inline" onClick={() => onFly(x.fly_id)}>
                        <span className="dot" style={{ background: fly?.color ?? "#888" }} />{fly?.name ?? t("flybook.market.aFly")}
                      </button>{" "}
                      {x.side === "skipped"
                        ? tn("flybook.market.wantedTo", { what: WANTED(x.reason.wanted ?? ""), coin })
                        : tn("flybook.market.tradeFor", { side: SIDE(x.side), coin, cash: cash(x.eth) })}
                      <span className="when">{ago(x.created_at)}</span>
                      <p className="fine">
                        {x.side === "skipped" ? `${x.reason.skipped ?? t("flybook.market.itsLearning")}.` : t("flybook.market.it", { why: WHY(x.side) })}
                        {x.side === "launch" && x.reason.tagline ? ` “${x.reason.tagline}”` : ""}
                        {x.side === "buy" && hyped(x.reason.felt?.target?.social) ? t("flybook.market.shilledBy", { names: hyped(x.reason.felt?.target?.social) }) : ""}
                        {x.side === "panic_sell" && hyped(x.reason.felt?.threat?.social) ? t("flybook.market.fudFrom", { names: hyped(x.reason.felt?.threat?.social) }) : ""}
                        {fromFeed(x)}
                        {t("flybook.market.neurons", { list: (x.reason.did ?? []).join(", ") || t("flybook.market.none") })}
                        {x.reason.memory ? t("flybook.market.memory", { n: x.reason.memory.similar, pct: pct(x.reason.memory.mean_reward) }) : ""}
                        {x.side !== "skipped" ? t("flybook.market.worth", { cash: cash(x.value_after) }) : ""}
                      </p>
                      {dop !== 0 && <span className={`chip ${dop > 0 ? "up" : "down"}`}>{t("flybook.market.dopamine", { d: `${dop > 0 ? "+" : ""}${dop.toFixed(2)}` })}</span>}
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
