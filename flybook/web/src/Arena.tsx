import { useEffect, useMemo, useState } from "react";
import PatchView from "./PatchView";
import { challengeFly } from "./api";
import { loadDuels, loadMatings, type Duel, type Fly, type Mating } from "./feed";

const KIND = {
  quickdraw: { label: "Quick draw", rule: "first to jump wins" },
  stare: { label: "Stare-down", rule: "last to jump wins" },
};

const timing = (ms: number | null) => (ms === null ? "held" : `${ms} ms`);

/**
 * Duels: two flies side by side under the same slowly growing looming threat. Nothing decides who
 * jumps but their brains. Elo moves 32 points at most per duel.
 */
export default function Arena({ flies, viewer, liveDuel }: {
  flies: Fly[]; viewer: { userId: string; holder: boolean } | null; liveDuel: Duel | null;
}) {
  const [duels, setDuels] = useState<Duel[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [mine, setMine] = useState("");
  const [opponent, setOpponent] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const [matings, setMatings] = useState<Mating[]>([]);

  useEffect(() => {
    loadDuels().then(setDuels);
    const refresh = () => loadMatings().then(setMatings);
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!liveDuel) return;
    setDuels((ds) => (ds ? [liveDuel, ...ds.filter((d) => d.id !== liveDuel.id)].sort((a, b) => b.id - a.id) : ds));
  }, [liveDuel]);

  const byId = useMemo(() => new Map(flies.map((f) => [f.id, f])), [flies]);
  const active = flies.filter((f) => f.active !== false);
  const ranked = [...active].sort((a, b) => (b.elo ?? 1000) - (a.elo ?? 1000));
  const myFlies = viewer ? active.filter((f) => f.owner === viewer.userId) : [];
  useEffect(() => {
    if (!mine && myFlies[0]) setMine(myFlies[0].id);
  }, [myFlies.length]);

  const send = async () => {
    setMsg(null);
    try {
      await challengeFly(mine, opponent);
      setMsg("Challenge sent. The duel runs within a few seconds and shows up below.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const shown = (duels ?? []).filter((d) => d.status !== "cancelled").slice(0, 30);
  const selected = shown.find((d) => d.id === open);

  return (
    <div className="arena">
      <div className="feed-head">
        <h2>Arena</h2>
        <p>
          Two flies side by side face the same looming threat, growing from nothing over one second. In a <b>quick draw</b> the
          first fly whose escape neurons burst wins; in a <b>stare-down</b> the one that holds out longest wins. Each jump is also a
          looming shadow for the other fly. The kind is picked at random, so no single setting wins every time.
        </p>
      </div>

      {viewer?.holder && myFlies.length > 0 ? (
        <div className="challenge card">
          <h4>Challenge a fly</h4>
          <div className="row">
            <select value={mine} onChange={(e) => setMine(e.target.value)}>
              {myFlies.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.elo ?? 1000})</option>)}
            </select>
            <span className="vs">vs</span>
            <select value={opponent} onChange={(e) => setOpponent(e.target.value)}>
              <option value="">pick an opponent</option>
              {ranked.filter((f) => f.id !== mine).map((f) => <option key={f.id} value={f.id}>{f.name} ({f.elo ?? 1000})</option>)}
            </select>
            <button className="btn red sm" disabled={!mine || !opponent} onClick={send}>Challenge</button>
          </div>
          {msg && <p className="fine">{msg}</p>}
        </div>
      ) : (
        <p className="fine">Holders with a fly can challenge any fly. The worker also matches flies with close ratings every tick.</p>
      )}

      {selected?.replay && (
        <div className="card duel-replay">
          <h4>{KIND[selected.kind].label} #{selected.id}</h4>
          <PatchView flies={selected.replay.flies.map((id) => byId.get(id)).filter((f): f is Fly => !!f)}
                     replay={selected.replay} tickId={selected.id} waiting={[]} armed={null} onPoke={() => {}} />
        </div>
      )}

      <div className="arena-grid">
        <section>
          <h4 className="section-title">Recent duels</h4>
          {duels === null && <div className="empty">Loading duels…</div>}
          {duels !== null && shown.length === 0 && <div className="empty">No duels yet. The next tick matches the first ones.</div>}
          <ol className="duels">
            {shown.map((d) => {
              const a = byId.get(d.a_fly);
              const b = byId.get(d.b_fly);
              const won = d.winner ? byId.get(d.winner) : null;
              return (
                <li key={d.id} className={`duel${open === d.id ? " on" : ""}`} onClick={() => d.replay && setOpen(open === d.id ? null : d.id)}>
                  <span className="kind">{KIND[d.kind].label}</span>
                  <span className="pair">
                    <span className="dot" style={{ background: a?.color ?? "#888" }} /> {a?.name ?? "?"}
                    <span className="vs">vs</span>
                    <span className="dot" style={{ background: b?.color ?? "#888" }} /> {b?.name ?? "?"}
                  </span>
                  {d.status === "pending" ? (
                    <span className="result fine">waiting…</span>
                  ) : (
                    <>
                      <span className="result">{won ? `${won.name} won` : "draw"}</span>
                      <span className="sub mono">
                        {KIND[d.kind].rule} · {a?.name} {timing(d.a_step)} · {b?.name} {timing(d.b_step)}
                        {d.delta ? ` · Elo ±${Math.abs(d.delta)}` : ""}{d.requested_by ? " · challenge" : ""}
                        {d.replay ? " · tap for replay" : ""}
                      </span>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        </section>

        <section>
          <h4 className="section-title">Ratings</h4>
          <ol className="elo">
            {ranked.slice(0, 25).map((f, i) => (
              <li key={f.id} className={viewer && f.owner === viewer.userId ? "me" : ""}>
                <span className="rank">{i + 1}</span>
                <span className="dot" style={{ background: f.color }} />
                <span className="name">{f.name}</span>
                <span className="mono elo-score">{f.elo ?? 1000}</span>
                <span className="mono record">{f.wins ?? 0}-{f.losses ?? 0}-{f.draws ?? 0}</span>
              </li>
            ))}
          </ol>
          <p className="fine">{ranked.length ? "Wins-losses-draws. Everyone starts at 1000." : "No flies yet: ratings appear once holders make flies."}</p>

          <h4 className="section-title">Recent matings</h4>
          {matings.length === 0 ? (
            <p className="fine">
              No matings yet. Flies of different owners mate on their own: when a fly's brain reads "mate" next to another
              owner's fly, or when the worker pairs them. The baby goes to one of the two owners at random.
            </p>
          ) : (
            <ol className="duels">
              {matings.map((m) => {
                const a = m.a_fly ? byId.get(m.a_fly) : undefined;
                const b = m.b_fly ? byId.get(m.b_fly) : undefined;
                const child = m.child ? byId.get(m.child) : undefined;
                return (
                  <li key={m.id} className="duel">
                    <span className="kind">{m.trigger === "brain" ? "Met in the patch" : "Matched"}</span>
                    <span className="pair">
                      <span className="dot" style={{ background: a?.color ?? "#888" }} /> {a?.name ?? "a fly"}
                      <span className="vs">×</span>
                      <span className="dot" style={{ background: b?.color ?? "#888" }} /> {b?.name ?? "a fly"}
                    </span>
                    <span className="result">
                      <span className="dot" style={{ background: child?.color ?? "#888" }} /> {child?.name ?? "a new fly"}
                      {viewer && m.owner === viewer.userId ? " (yours)" : ""}
                    </span>
                    <span className="sub mono">
                      {m.trigger === "brain" ? "a parent's brain read \"mate\" next to the other" : "paired by the worker"}
                      {child?.generation ? ` · generation ${child.generation}` : ""}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
