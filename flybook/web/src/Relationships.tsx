import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { loadBonds, type Bond, type BondLabel, type Fly } from "./feed";

/** How each relationship looks. tone picks the line colour (warm, kin, cold, neutral); dash tells mixed ones apart. */
const LABELS: Record<BondLabel, { icon: string; title: string; tone: "warm" | "kin" | "cold" | "neutral"; dash?: string; help: string }> = {
  mates: { icon: "💘", title: "Mates", tone: "warm", help: "had a baby together" },
  family: { icon: "🧬", title: "Family", tone: "kin", help: "parent, child or sibling" },
  "best friends": { icon: "💞", title: "Best friends", tone: "warm", help: "catch each other's eye all the time, almost never startle" },
  friends: { icon: "🤝", title: "Friends", tone: "warm", help: "their moves draw each other in" },
  frenemies: { icon: "😬", title: "Frenemies", tone: "cold", dash: "10 5", help: "close, but they keep making each other jump" },
  rivals: { icon: "⚔️", title: "Rivals", tone: "cold", dash: "2 5", help: "keep meeting in the Arena" },
  enemies: { icon: "💢", title: "Enemies", tone: "cold", help: "one makes the other jump" },
  acquaintances: { icon: "👋", title: "Acquaintances", tone: "neutral", help: "crossed paths a few times" },
};
const ORDER: BondLabel[] = ["mates", "family", "best friends", "friends", "frenemies", "rivals", "enemies", "acquaintances"];
const DAYS = [1, 7, 30] as const;
const GRAPH_MAX = 24;

/** A bond seen from one fly: `me` and `other`, with each count split into what I felt and what they felt. */
type Side = {
  bond: Bond; other: string;
  startledMe: number; startledThem: number; drewMe: number; drewThem: number; touchedMe: number; touchedThem: number;
  wins: number; losses: number; draws: number; kin: "parent" | "child" | "sibling" | null;
  weight: number;
};

function side(b: Bond, me: string): Side {
  const mine = b.a === me;
  const kin = b.kin === "siblings" ? "sibling" : !b.kin ? null : (b.kin === "a_parent") === mine ? "child" : "parent";   // what the other is to me
  return {
    bond: b, other: mine ? b.b : b.a,
    startledMe: mine ? b.a_startled : b.b_startled, startledThem: mine ? b.b_startled : b.a_startled,
    drewMe: mine ? b.a_drawn : b.b_drawn, drewThem: mine ? b.b_drawn : b.a_drawn,
    touchedMe: mine ? b.a_touched : b.b_touched, touchedThem: mine ? b.b_touched : b.a_touched,
    wins: mine ? b.a_wins : b.b_wins, losses: mine ? b.b_wins : b.a_wins, draws: b.draws, kin,
    weight: weightOf(b),
  };
}

const weightOf = (b: Bond) => b.warmth + b.tension + 3 * (b.a_wins + b.b_wins + b.draws) + 20 * b.matings + (b.kin ? 10 : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (s: string, n = 12) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** One line on what happened between the two, the biggest things first. */
function story(s: Side, name: string): string {
  const bits: string[] = [];
  if (s.bond.matings) bits.push(`${plural(s.bond.matings, "baby", "babies")} together`);
  if (s.kin) bits.push(`${name} is its ${s.kin}`);
  if (s.drewMe + s.drewThem) bits.push(`caught each other's eye ${s.drewMe + s.drewThem}×`);
  if (s.startledMe + s.startledThem) bits.push(`made each other jump ${s.startledMe + s.startledThem}×`);
  if (s.touchedMe + s.touchedThem) bits.push(`bumped ${s.touchedMe + s.touchedThem}×`);
  if (s.wins + s.losses + s.draws) bits.push(`duels ${s.wins}-${s.losses}${s.draws ? `-${s.draws}` : ""}`);
  return bits.join(" · ") || "barely met";
}

/** The fly's relationships as a popup: a web around the fly, the highlights, and every relationship grouped. */
export default function Relationships({ fly, flies, onClose, onFly }: {
  fly: Fly | null; flies: Map<string, Fly>; onClose: () => void; onFly: (id: string) => void;
}) {
  const [focus, setFocus] = useState<string | null>(fly?.id ?? null);
  const [days, setDays] = useState<(typeof DAYS)[number]>(7);
  const [bonds, setBonds] = useState<Bond[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    setBonds(null);
    setError(null);
    setPicked(null);
    loadBonds(focus, days)
      .then((rows) => live && setBonds(rows.filter((b) => flies.has(b.a) && flies.has(b.b))))
      .catch((e) => live && setError(e?.message ?? String(e)));
    return () => { live = false; };
  }, [focus, days]);

  const me = focus ? flies.get(focus) : undefined;
  const title = me ? `${me.name}'s relationships` : "The social web";

  return createPortal(
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal bonds" role="dialog" aria-modal="true" aria-labelledby="bonds-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3 id="bonds-title">
            {me && <span className="dot big" style={{ background: me.color }} />}
            {title}
          </h3>
          <button className="more" type="button" onClick={onClose}>close ✕</button>
        </header>
        <div className="bonds-controls">
          <div className="seg" role="group" aria-label="Whose relationships">
            {(me || fly) && (
              <button className={focus ? "on" : ""} onClick={() => !focus && fly && setFocus(fly.id)}>{short((me ?? fly)!.name, 16)}</button>
            )}
            <button className={focus ? "" : "on"} onClick={() => setFocus(null)}>Everyone</button>
          </div>
          <div className="seg" role="group" aria-label="Time window">
            {DAYS.map((d) => (
              <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>{d === 1 ? "24h" : `${d}d`}</button>
            ))}
          </div>
        </div>
        <div className="modal-scroll">
          <p className="modal-lede">
            Nobody picks these. They come from what the flies' brains did to each other: jumps one set off in the other, moves that
            caught an eye, bumps, duels and babies. Older stuff fades, so friends can turn into enemies.
          </p>
          {error && <p className="err">{error}</p>}
          {!bonds && !error && <div className="empty">Reading who likes whom…</div>}
          {bonds && focus && me && (
            <FlyBonds me={me} bonds={bonds} flies={flies} picked={picked} hover={hover}
                      onPick={setPicked} onHover={setHover} onFocus={setFocus} onFly={(id) => { onFly(id); onClose(); }} />
          )}
          {bonds && !focus && (
            <SocialWeb bonds={bonds} flies={flies} hover={hover} onHover={setHover} onFocus={setFocus} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function FlyBonds({ me, bonds, flies, picked, hover, onPick, onHover, onFocus, onFly }: {
  me: Fly; bonds: Bond[]; flies: Map<string, Fly>; picked: string | null; hover: string | null;
  onPick: (id: string | null) => void; onHover: (id: string | null) => void; onFocus: (id: string) => void; onFly: (id: string) => void;
}) {
  const sides = useMemo(
    () => bonds.filter((b) => b.a === me.id || b.b === me.id).map((b) => side(b, me.id)).sort((x, y) => y.weight - x.weight),
    [bonds, me.id],
  );
  if (sides.length === 0) {
    return <div className="empty">No relationships yet. {me.name} needs neighbours: flies in the same patch set each other off.</div>;
  }
  const best = (label: BondLabel[]) => sides.find((s) => label.includes(s.bond.label));
  const highlights = [
    { key: "friend", label: "Best friend", s: best(["best friends", "friends"]) },
    { key: "enemy", label: "Worst enemy", s: best(["enemies", "frenemies"]) },
    { key: "rival", label: "Top rival", s: [...sides].filter((s) => s.wins + s.losses + s.draws > 0).sort((x, y) => (y.wins + y.losses + y.draws) - (x.wins + x.losses + x.draws))[0] },
    { key: "scary", label: "Scares it most", s: [...sides].filter((s) => s.startledMe > 0).sort((x, y) => y.startledMe - x.startledMe)[0] },
  ];
  const counts = ORDER.map((l) => [l, sides.filter((s) => s.bond.label === l).length] as const).filter(([, n]) => n > 0);
  const selected = sides.find((s) => s.other === picked) ?? null;

  return (
    <>
      <ul className="bond-counts" aria-label="Relationships by kind">
        {counts.map(([l, n]) => (
          <li key={l} className={`tone-${LABELS[l].tone}`} title={LABELS[l].help}><span aria-hidden>{LABELS[l].icon}</span> <b>{n}</b> {LABELS[l].title.toLowerCase()}</li>
        ))}
      </ul>
      <div className="bonds-grid">
        <div className="bond-graph-wrap">
          <EgoGraph me={me} sides={sides.slice(0, GRAPH_MAX)} flies={flies} picked={picked} hover={hover} onPick={onPick} onHover={onHover} />
          <Legend />
          {sides.length > GRAPH_MAX && <p className="fine">The web shows the {GRAPH_MAX} strongest of {sides.length}; all are listed below.</p>}
        </div>
        <div className="bond-side">
          {selected ? (
            <PairCard s={selected} me={me} other={flies.get(selected.other)!} onClose={() => onPick(null)} onFocus={onFocus} onFly={onFly} />
          ) : (
            <ul className="bond-highlights">
              {highlights.map(({ key, label, s }) => {
                const f = s ? flies.get(s.other) : undefined;
                return (
                  <li key={key}>
                    <span className="fine">{label}</span>
                    {s && f ? (
                      <button className="who" onClick={() => onPick(s.other)}>
                        <span className="dot" style={{ background: f.color }} />{f.name}
                        <span className="bond-why">{key === "scary" ? `made it jump ${s.startledMe}×` : key === "rival" ? `${s.wins}-${s.losses}${s.draws ? `-${s.draws}` : ""} in duels` : LABELS[s.bond.label].title}</span>
                      </button>
                    ) : <span className="bond-none">nobody yet</span>}
                  </li>
                );
              })}
              <li className="fine">Click a fly in the web to see what happened between them.</li>
            </ul>
          )}
        </div>
      </div>
      <div className="bond-list">
        {ORDER.map((l) => {
          const group = sides.filter((s) => s.bond.label === l);
          if (!group.length) return null;
          return (
            <section key={l}>
              <h5><span aria-hidden>{LABELS[l].icon}</span> {LABELS[l].title} <small>{LABELS[l].help}</small></h5>
              <ul>
                {group.map((s) => {
                  const f = flies.get(s.other)!;
                  return (
                    <li key={s.other} className={picked === s.other ? "on" : ""}>
                      <button className="who" onClick={() => onPick(s.other)}><span className="dot" style={{ background: f.color }} />{f.name}</button>
                      <Mood warmth={s.bond.warmth} tension={s.bond.tension} />
                      <span className="bond-story">{story(s, f.name)}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}

/** Warmth vs tension as one diverging bar: red to the left of the middle, green to the right. */
function Mood({ warmth, tension }: { warmth: number; tension: number }) {
  const total = warmth + tension;
  if (total <= 0) return <span className="mood none" title="no brain reactions, only duels or family" />;
  const warm = warmth / total;
  return (
    <span className="mood" role="img" aria-label={`${Math.round(warm * 100)}% warm, ${Math.round((1 - warm) * 100)}% tense`}
          title={`${Math.round(warm * 100)}% warm · ${Math.round((1 - warm) * 100)}% tense`}>
      <i className="cold" style={{ width: `${(1 - warm) * 50}%` }} />
      <i className="warm" style={{ width: `${warm * 50}%` }} />
    </span>
  );
}

function Legend() {
  return (
    <ul className="bond-legend" aria-label="Line colours">
      <li><svg width="26" height="8" aria-hidden><line x1="1" y1="4" x2="25" y2="4" className="edge tone-warm" /></svg>friendly</li>
      <li><svg width="26" height="8" aria-hidden><line x1="1" y1="4" x2="25" y2="4" className="edge tone-kin" /></svg>family</li>
      <li><svg width="26" height="8" aria-hidden><line x1="1" y1="4" x2="25" y2="4" className="edge tone-cold" /></svg>enemies</li>
      <li><svg width="26" height="8" aria-hidden><line x1="1" y1="4" x2="25" y2="4" className="edge tone-cold" strokeDasharray="10 5" /></svg>frenemies</li>
      <li><svg width="26" height="8" aria-hidden><line x1="1" y1="4" x2="25" y2="4" className="edge tone-cold" strokeDasharray="2 5" /></svg>rivals</li>
      <li><svg width="26" height="8" aria-hidden><line x1="1" y1="4" x2="25" y2="4" className="edge tone-neutral" /></svg>acquaintances</li>
      <li className="fine">thicker = closer</li>
    </ul>
  );
}

const EW = 700, EH = 480, CX = EW / 2, CY = EH / 2;     // one fly's web
const WW = 900, WH = 600;                                // everyone's web

/** The fly in the middle; closer and thicker means more happened between them. Grouped around the circle by kind,
 * the closest flies nearest the middle (by rank, so one huge friendship doesn't push everyone else to the edge). */
function EgoGraph({ me, sides, flies, picked, hover, onPick, onHover }: {
  me: Fly; sides: Side[]; flies: Map<string, Fly>; picked: string | null; hover: string | null;
  onPick: (id: string | null) => void; onHover: (id: string | null) => void;
}) {
  const rank = new Map([...sides].sort((x, y) => y.weight - x.weight).map((s, i) => [s.other, i]));
  const n = sides.length;
  const placed = [...sides]
    .sort((x, y) => ORDER.indexOf(x.bond.label) - ORDER.indexOf(y.bond.label) || y.weight - x.weight)
    .map((s, i) => {
      const close = n > 1 ? 1 - rank.get(s.other)! / (n - 1) : 1;         // 1 = closest
      const r = 205 - close * 100 + (n > 10 ? (i % 2 ? 16 : -16) : 0);    // alternate rings so neighbours' names don't collide
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
      return { s, angle, x: CX + r * 1.15 * Math.cos(angle), y: CY + r * 0.95 * Math.sin(angle), close };
    });
  const tip = placed.find((p) => p.s.other === hover);
  return (
    <div className="bond-graph">
      <svg viewBox={`0 0 ${EW} ${EH}`} role="img" aria-label={`${me.name}'s relationships: ${sides.length} flies`}>
        {placed.map(({ s, x, y, close }) => {
          const meta = LABELS[s.bond.label];
          const on = picked === s.other || hover === s.other;
          return (
            <g key={`e-${s.other}`} className={picked && !on ? "faded" : ""}>
              <line x1={CX} y1={CY} x2={x} y2={y} className={`edge tone-${meta.tone}${on ? " on" : ""}`}
                    strokeWidth={1.5 + close * 4.5} strokeDasharray={meta.dash} />
              {s.bond.label !== "acquaintances" && s.bond.label !== "friends" && (
                <text x={(CX + x) / 2} y={(CY + y) / 2} className="edge-icon" textAnchor="middle" dominantBaseline="central">{meta.icon}</text>
              )}
            </g>
          );
        })}
        {placed.map(({ s, x, y, close, angle }) => {
          const f = flies.get(s.other)!;
          const on = picked === s.other || hover === s.other;
          const dot = 8 + close * 6;
          const cos = Math.cos(angle), sin = Math.sin(angle);                // names sit outside the node, away from the middle
          const anchor = cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle";
          const lx = x + cos * (dot + 6), ly = y + sin * (dot + 6) + (anchor === "middle" ? (sin > 0 ? 10 : -4) : 4);
          return (
            <g key={`n-${s.other}`} className={`node${on ? " on" : ""}${picked && !on ? " faded" : ""}`} tabIndex={0} role="button"
               aria-label={`${f.name}: ${LABELS[s.bond.label].title}`}
               onClick={() => onPick(picked === s.other ? null : s.other)}
               onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onPick(s.other)}
               onMouseEnter={() => onHover(s.other)} onMouseLeave={() => onHover(null)}>
              <circle cx={x} cy={y} r={22} className="hit" />
              <circle cx={x} cy={y} r={dot} fill={f.color} className="ring" />
              <text x={lx} y={ly} textAnchor={anchor} className="node-name">{short(f.name)}</text>
            </g>
          );
        })}
        <g className="node me">
          <circle cx={CX} cy={CY} r={20} fill={me.color} className="ring" />
          <text x={CX} y={CY + 38} textAnchor="middle" className="node-name me">{short(me.name, 16)}</text>
        </g>
      </svg>
      {tip && (
        <div className="bond-tip" style={{ left: `${(tip.x / EW) * 100}%`, top: `${(tip.y / EH) * 100}%` }}>
          <b>{flies.get(tip.s.other)?.name}</b> <span>{LABELS[tip.s.bond.label].icon} {LABELS[tip.s.bond.label].title}</span>
          <small>{story(tip.s, flies.get(tip.s.other)?.name ?? "it")}</small>
        </div>
      )}
    </div>
  );
}

/** Everything between two flies, both ways round. */
function PairCard({ s, me, other, onClose, onFocus, onFly }: {
  s: Side; me: Fly; other: Fly; onClose: () => void; onFocus: (id: string) => void; onFly: (id: string) => void;
}) {
  const meta = LABELS[s.bond.label];
  const rows = [
    { label: "made the other jump", them: s.startledMe, mine: s.startledThem },
    { label: "caught the other's eye", them: s.drewMe, mine: s.drewThem },
    { label: "bumped the other", them: s.touchedMe, mine: s.touchedThem },
  ];
  const peak = Math.max(1, ...rows.flatMap((r) => [r.them, r.mine]));
  return (
    <div className="pair-card">
      <div className="pair-head">
        <span className={`pair-label tone-${meta.tone}`}>{meta.icon} {meta.title}</span>
        <button className="more" onClick={onClose}>back</button>
      </div>
      <p className="pair-names">
        <span className="dot" style={{ background: me.color }} />{me.name}
        <span className="vs">&amp;</span>
        <span className="dot" style={{ background: other.color }} />{other.name}
      </p>
      <p className="fine">{meta.help}{s.bond.last_at ? ` · last ${ago(s.bond.last_at)}` : ""}</p>
      <Mood warmth={s.bond.warmth} tension={s.bond.tension} />
      <table className="pair-table">
        <thead>
          <tr><th /><th scope="col">by {short(other.name, 10)}</th><th scope="col">by {short(me.name, 10)}</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td><span className="pair-bar" style={{ width: `${(r.them / peak) * 100}%` }} /><span className="mono">{r.them}</span></td>
              <td><span className="pair-bar" style={{ width: `${(r.mine / peak) * 100}%` }} /><span className="mono">{r.mine}</span></td>
            </tr>
          ))}
          <tr>
            <th scope="row">duel wins</th>
            <td><span className="mono">{s.losses}</span></td>
            <td><span className="mono">{s.wins}</span></td>
          </tr>
        </tbody>
      </table>
      {(s.draws > 0 || s.bond.matings > 0 || s.kin) && (
        <p className="fine">
          {[s.draws ? plural(s.draws, "drawn duel") : "", s.bond.matings ? `${plural(s.bond.matings, "baby", "babies")} together` : "",
            s.kin ? `${other.name} is ${me.name}'s ${s.kin}` : ""].filter(Boolean).join(" · ")}
        </p>
      )}
      <div className="row">
        <button className="btn sm" onClick={() => onFocus(other.id)}>See {short(other.name, 14)}'s web</button>
        <button className="btn sm" onClick={() => onFly(other.id)}>Their posts</button>
      </div>
    </div>
  );
}

/** Every fly and every relationship, laid out so flies that interact a lot sit together (a small force layout). */
function SocialWeb({ bonds, flies, hover, onHover, onFocus }: {
  bonds: Bond[]; flies: Map<string, Fly>; hover: string | null; onHover: (id: string | null) => void; onFocus: (id: string) => void;
}) {
  // in a small world nearly every fly has met every other: family, rivals and acquaintances start hidden so the web stays readable
  const [kinds, setKinds] = useState<Set<BondLabel>>(() => new Set<BondLabel>(["mates", "best friends", "friends", "frenemies", "enemies"]));
  const kindKey = [...kinds].sort().join("|");
  const shown = useMemo(() => bonds.filter((b) => kinds.has(b.label)), [bonds, kindKey]);
  const { nodes, degree } = useMemo(() => layout(shown), [shown]);
  if (!bonds.length) return <div className="empty">No relationships in this window yet.</div>;
  const max = Math.max(...shown.map(weightOf), 1);
  const near = hover ? new Set(shown.filter((b) => b.a === hover || b.b === hover).flatMap((b) => [b.a, b.b])) : null;
  const tally = ORDER.map((l) => [l, bonds.filter((b) => b.label === l).length] as const).filter(([, n]) => n > 0);
  const toggle = (l: BondLabel) => setKinds((k) => {
    const next = new Set(k);
    if (next.has(l)) next.delete(l);
    else next.add(l);
    return next;
  });
  return (
    <>
      <ul className="bond-counts toggles" aria-label="Show these relationships">
        {tally.map(([l, n]) => (
          <li key={l}>
            <button className={`tone-${LABELS[l].tone}${kinds.has(l) ? " on" : ""}`} aria-pressed={kinds.has(l)} onClick={() => toggle(l)}
                    title={`${LABELS[l].help} · click to ${kinds.has(l) ? "hide" : "show"}`}>
              <span aria-hidden>{LABELS[l].icon}</span> <b>{n}</b> {LABELS[l].title.toLowerCase()}
            </button>
          </li>
        ))}
      </ul>
      {!nodes.size ? <div className="empty">Nothing to show. Switch on a kind of relationship above.</div> : (
      <div className="bond-graph web">
        <svg viewBox={`0 0 ${WW} ${WH}`} role="img" aria-label={`Social web: ${nodes.size} flies, ${shown.length} relationships`}>
          {shown.map((b) => {
            const p = nodes.get(b.a), q = nodes.get(b.b);
            if (!p || !q) return null;
            const meta = LABELS[b.label];
            const on = !near || (near.has(b.a) && near.has(b.b) && (b.a === hover || b.b === hover));
            return (
              <line key={`${b.a}-${b.b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className={`edge tone-${meta.tone}${on ? "" : " faded"}`}
                    strokeWidth={1 + (Math.log1p(weightOf(b)) / Math.log1p(max)) * 3.5} strokeDasharray={meta.dash} />
            );
          })}
          {[...nodes].map(([id, p]) => {
            const f = flies.get(id);
            if (!f) return null;
            const on = !near || near.has(id);
            const r = 6 + Math.min(8, Math.sqrt(degree.get(id) ?? 0) * 2);
            return (
              <g key={id} className={`node${on ? "" : " faded"}`} tabIndex={0} role="button" aria-label={`${f.name}: open its relationships`}
                 onClick={() => onFocus(id)} onKeyDown={(e) => e.key === "Enter" && onFocus(id)}
                 onMouseEnter={() => onHover(id)} onMouseLeave={() => onHover(null)}>
                <circle cx={p.x} cy={p.y} r={18} className="hit" />
                <circle cx={p.x} cy={p.y} r={r} fill={f.color} className="ring" />
                {(hover === id || (degree.get(id) ?? 0) >= 4 || nodes.size <= 16) && (
                  <text x={p.x} y={p.y + r + 13} textAnchor="middle" className="node-name">{short(f.name)}</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      )}
      <Legend />
      <p className="fine">Click a kind above to show or hide it, and a fly to open its relationships.</p>
    </>
  );
}

/** Fruchterman-Reingold in the SVG box, seeded on a circle so the same bonds always land the same way. */
function layout(bonds: Bond[]): { nodes: Map<string, { x: number; y: number }>; degree: Map<string, number> } {
  const ids = [...new Set(bonds.flatMap((b) => [b.a, b.b]))].sort();
  const degree = new Map<string, number>();
  for (const b of bonds) for (const id of [b.a, b.b]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const n = ids.length;
  const index = new Map(ids.map((id, i) => [id, i]));
  const mx = WW / 2, my = WH / 2;
  const px = ids.map((_, i) => mx + 220 * Math.cos((2 * Math.PI * i) / Math.max(1, n)));
  const py = ids.map((_, i) => my + 220 * Math.sin((2 * Math.PI * i) / Math.max(1, n)));
  const k = Math.sqrt((WW * WH) / Math.max(1, n)) * 0.75;
  const max = Math.max(...bonds.map(weightOf), 1);
  const edges = bonds.map((b) => [index.get(b.a)!, index.get(b.b)!, 0.3 + 0.7 * Math.log1p(weightOf(b)) / Math.log1p(max)] as const);
  let temp = WW / 8;
  for (let it = 0; it < 260; it++) {
    const dx = new Array(n).fill(0), dy = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ex = px[i] - px[j], ey = py[i] - py[j];
        const d2 = Math.max(0.01, ex * ex + ey * ey), f = (k * k) / d2;
        dx[i] += ex * f; dy[i] += ey * f; dx[j] -= ex * f; dy[j] -= ey * f;
      }
    }
    for (const [i, j, w] of edges) {
      const ex = px[i] - px[j], ey = py[i] - py[j];
      const d = Math.max(0.1, Math.hypot(ex, ey)), f = (d / k) * w;
      dx[i] -= ex * f; dy[i] -= ey * f; dx[j] += ex * f; dy[j] += ey * f;
    }
    for (let i = 0; i < n; i++) {
      dx[i] += (mx - px[i]) * 0.004; dy[i] += (my - py[i]) * 0.004;   // a little gravity keeps loose flies on screen
      const d = Math.max(0.1, Math.hypot(dx[i], dy[i])), step = Math.min(d, temp);
      px[i] = Math.min(WW - 60, Math.max(60, px[i] + (dx[i] / d) * step));
      py[i] = Math.min(WH - 30, Math.max(24, py[i] + (dy[i] / d) * step));
    }
    temp = Math.max(1, temp * 0.97);
  }
  return { nodes: new Map(ids.map((id, i) => [id, { x: px[i], y: py[i] }])), degree };
}
