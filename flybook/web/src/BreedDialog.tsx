import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { breedFly } from "./api";
import { tuning, type Fly, type Patch } from "./feed";
import { NATURAL, StylePicker, styleBody, type Style } from "./TradingStyle";

const COLORS = ["#e0342c", "#3ddc84", "#6cc4d8", "#f2b544", "#c77dff", "#ff7eb6", "#8bd450", "#ff9f5a"];

/** Breed a new fly from one of yours and another of yours, or a house fly. */
export default function BreedDialog({ mine, house, patches, onClose, onCreated }: {
  mine: Fly[]; house: Fly[]; patches: Patch[]; onClose: () => void; onCreated: () => void;
}) {
  const [a, setA] = useState(mine[0]?.id ?? "");
  const [b, setB] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[4]);
  const [patch, setPatch] = useState(patches[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [child, setChild] = useState<Fly | null>(null);
  const [trade, setTrade] = useState<Style>(NATURAL);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const candidates = [...mine.filter((f) => f.id !== a), ...house];
  const parentA = mine.find((f) => f.id === a);
  const parentB = candidates.find((f) => f.id === b);

  const hatch = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await breedFly({ parent_a: a, parent_b: b, name: name.trim(), color, patch_id: patch, style: styleBody(trade) });
      setChild(made as Fly);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const describe = (f?: Fly) => (f ? tuning(f).join(", ") || "standard" : "");

  return createPortal(
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal breed" role="dialog" aria-modal="true" aria-labelledby="breed-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3 id="breed-title">Breed a fly</h3>
          <button className="more" type="button" onClick={onClose}>close ✕</button>
        </header>
        <div className="modal-scroll">
          <p className="modal-lede">
            The child takes each sense, temperament and neuron setting from one parent at random. Then a few values mutate a
            little, and now and then a neuron group flips. It runs the same connectome as every fly; only the settings are
            inherited.
          </p>
          {child ? (
            <div className="bred">
              <p><b>{child.name}</b> hatched: generation {child.generation}.</p>
              <p className="fine">Settings: {describe(child)}</p>
              <button className="btn red" onClick={onClose}>Done</button>
            </div>
          ) : (
            <>
              <div className="identity">
                <label className="field">
                  <span>Parent 1 (yours)</span>
                  <select value={a} onChange={(e) => setA(e.target.value)}>
                    {mine.map((f) => <option key={f.id} value={f.id}>{f.name} (gen {f.generation ?? 1})</option>)}
                  </select>
                  <small>{describe(parentA)}</small>
                </label>
                <label className="field">
                  <span>Parent 2</span>
                  <select value={b} onChange={(e) => setB(e.target.value)}>
                    <option value="">pick a parent</option>
                    {candidates.map((f) => <option key={f.id} value={f.id}>{f.name}{f.owner ? "" : " (house)"}</option>)}
                  </select>
                  <small>{describe(parentB)}</small>
                </label>
                <label className="field">
                  <span>Home patch</span>
                  <select value={patch} onChange={(e) => setPatch(e.target.value)}>
                    {patches.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
              </div>
              <div className="identity">
                <label className="field">
                  <span>Name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Buzz Junior" />
                </label>
                <div className="field">
                  <span>Colour</span>
                  <div className="swatches">
                    {COLORS.map((c) => (
                      <button type="button" key={c} className={c === color ? "on" : ""} style={{ background: c }}
                              onClick={() => setColor(c)} aria-label={`colour ${c}`} />
                    ))}
                  </div>
                </div>
              </div>
              <details className="breed-style">
                <summary>Trading style <small>{styleBody(trade) ? "custom" : "inherited"}</small></summary>
                <StylePicker value={trade} onChange={setTrade}
                             naturalHelp="Risk and what they learned from its parents, all learners on." />
              </details>
              {error && <p className="err">{error}</p>}
            </>
          )}
        </div>
        {!child && (
          <footer className="modal-foot">
            <span className="fine">Counts toward your 3 flies.</span>
            <button className="btn red" disabled={busy || !a || !b || !name.trim()} onClick={hatch}>{busy ? "Hatching…" : "Hatch the child"}</button>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
