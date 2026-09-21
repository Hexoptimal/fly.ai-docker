import { coinImage, type FlyCoin, type MarketSocial, type Trader } from "./feed";
import { ago, cash, pct } from "./FlyWallet";
import { t, tOr, tn } from "./i18n";

const PERSONA = (p: string) => tOr(`flybook.coins.persona.${p}`, p);
const ONE = (bond: string) => tOr(`flybook.coins.bond.${bond}`, "");

/** Big numbers short: 1.2k, 3.4M. */
const compact = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : `${Math.round(x)}`);

function Who({ id, name, color, onFly }: { id: string | null; name?: string | null; color?: string | null; onFly: (id: string) => void }) {
  if (!id) return <b>{t("flybook.coins.aFly")}</b>;
  return (
    <button className="who inline" onClick={() => onFly(id)}>
      <span className="dot" style={{ background: color ?? "#888" }} />{name ?? t("flybook.coins.aFly")}
    </button>
  );
}

/** Coins the flies launched themselves: logo, creator, price, market cap, holders. */
export function FlyCoins({ coins, onFly }: { coins: FlyCoin[]; onFly: (id: string) => void }) {
  const sorted = [...coins].sort((a, b) => (a.status === b.status ? (b.market_cap ?? 0) - (a.market_cap ?? 0) : a.status === "live" ? -1 : 1));
  return (
    <section className="fly-coins-wrap">
      <h4>{t("flybook.coins.title")}</h4>
      {sorted.length === 0 ? (
        <p className="fine">{t("flybook.coins.none")}</p>
      ) : (
        <ul className="fly-coins">
          {sorted.map((c) => (
            <li key={c.symbol} className={`fly-coin${c.status === "dead" ? " dead" : ""}`}>
              {c.image_path
                ? <img src={coinImage(c.image_path)} alt={t("flybook.coins.logoAlt", { symbol: c.symbol })} loading="lazy" />
                : <span className="coin-blank" style={{ background: c.creator_color ?? "#555" }}>{c.symbol.slice(0, 3)}</span>}
              <div className="fly-coin-main">
                <div className="coin-top">
                  <b>${c.symbol}</b>
                  {c.status === "dead" ? <span className="badge dead">{t("flybook.coins.rugged")}</span> : c.persona && <span className="badge meme">{PERSONA(c.persona)}</span>}
                </div>
                <span className="fine">{c.name}</span>
                {c.tagline && <span className="tagline">“{c.tagline}”</span>}
                <span className="fine">{tn("flybook.coins.by", { who: <Who id={c.creator} name={c.creator_name} color={c.creator_color} onFly={onFly} /> })}
                  {c.launched_at ? ` · ${ago(c.launched_at)}` : ""}</span>
                <div className="fly-coin-stats mono">
                  <span title={t("flybook.coins.price")}>{cash(c.price)}</span>
                  {c.since_launch !== null && <span className={c.since_launch >= 0 ? "up" : "down"} title={t("flybook.coins.sinceLaunch")}>{pct(c.since_launch)}</span>}
                  <span title={t("flybook.coins.mcapTitle")}>{t("flybook.coins.mcap", { cash: cash(c.market_cap ?? 0) })}</span>
                  <span title={t("flybook.coins.holdersTitle")}>{t("flybook.coins.holders", { count: c.holders })}</span>
                  <span title={t("flybook.coins.poolTitle")}>{t("flybook.coins.pool", { cash: cash(c.pool_eth ?? 0) })}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What the flies did with their coins: launches, shills, FUD, buybacks, dumps. */
export function Drama({ social, traders, coins, onFly }: {
  social: MarketSocial[]; traders: Map<string, Trader>; coins: FlyCoin[]; onFly: (id: string) => void;
}) {
  const bySymbol = new Map(coins.map((c) => [c.symbol, c]));
  const who = (id: string | null) => {
    const t = id ? traders.get(id) : undefined;
    return <Who id={id} name={t?.name} color={t?.color} onFly={onFly} />;
  };
  return (
    <section>
      <h4>{t("flybook.coins.drama")}</h4>
      {social.length === 0 && <div className="empty">{t("flybook.coins.quiet")}</div>}
      <ul className="trades drama">
        {social.map((e) => {
          const coin = bySymbol.get(e.symbol);
          const sym = <b>${e.symbol}</b>;
          const friends = e.reach > 0 ? t("flybook.coins.friends", { n: compact(e.reach), count: e.reach }) : "";
          let line: React.ReactNode;
          let icon = "";
          if (e.kind === "launch") {
            icon = "🚀";
            line = <>{tn("flybook.coins.launched", { who: who(e.fly_id), coin: sym })}{(e.detail.number ?? 1) > 1 ? t("flybook.coins.secondCoin") : ""}</>;
          } else if (e.kind === "shill") {
            icon = "📣";
            line = <>{tn("flybook.coins.shilling", { who: who(e.fly_id), coin: sym })}{friends}</>;
          } else if (e.kind === "fud") {
            icon = "🤬";
            const creator = e.detail.creator ?? coin?.creator ?? null;
            line = <>{tn("flybook.coins.fud", { who: who(e.fly_id), coin: sym })}
              {creator && e.detail.bond && ONE(e.detail.bond) ? tn("flybook.coins.madeBy", { bond: ONE(e.detail.bond), creator: who(creator) }) : null}</>;
          } else if (e.kind === "buyback") {
            icon = "🛟";
            line = <>{tn("flybook.coins.boughtBack", { who: who(e.fly_id), coin: sym })}{e.detail.eth ? t("flybook.coins.forCash", { cash: cash(e.detail.eth) }) : ""}</>;
          } else {
            icon = "🪦";
            line = tn("flybook.coins.dumped", { who: who(e.fly_id), coin: sym });
          }
          return (
            <li key={e.id} className={`drama-${e.kind}`}>
              <span className="event-icon">{icon}</span> {line}
              <span className="when">{ago(e.created_at)}</span>
              {e.kind === "launch" && e.detail.tagline && <p className="fine">“{e.detail.tagline}”</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
