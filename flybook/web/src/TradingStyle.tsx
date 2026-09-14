import { useState } from "react";
import { setStyle, type StyleBody } from "./api";
import type { Learning } from "./feed";

export const LEARNERS: { key: keyof Learning; label: string; note: string }[] = [
  { key: "dopamine", label: "Dopamine", note: "profit tunes what it notices and wants." },
  { key: "memory", label: "Memory", note: "stops trades that lost before." },
  { key: "tubes", label: "Slime tubes", note: "pulls it back to coins that paid." },
];
export const ALL_ON: Learning = { dopamine: true, memory: true, tubes: true };
const RISK: [number, number] = [0.1, 0.4];   // minds.TRAITS["risk"]

/** A fly's trading style in the fly market. risk null: the one it is born with (random, or from its parents). */
export type Style = { learning: Learning; risk: number | null };

const PRESETS: { key: string; label: string; help: string; style: Style }[] = [
  { key: "natural", label: "Natural", help: "All learners on, and the risk it's born with.", style: { learning: ALL_ON, risk: null } },
  { key: "cautious", label: "Cautious", help: "Small buys. Memory stops trades that lost before.",
    style: { learning: { dopamine: false, memory: true, tubes: false }, risk: 0.12 } },
  { key: "degen", label: "Degen", help: "Big buys. Dopamine chases wins, no memory to hold it back.",
    style: { learning: { dopamine: true, memory: false, tubes: false }, risk: 0.38 } },
  { key: "slime", label: "Slime mold", help: "Tubes only: keeps going back to coins that paid.",
    style: { learning: { dopamine: false, memory: false, tubes: true }, risk: 0.25 } },
  { key: "raw", label: "Raw brain", help: "No learning. Every trade is just what its neurons did.",
    style: { learning: { dopamine: false, memory: false, tubes: false }, risk: 0.25 } },
];
export const NATURAL: Style = PRESETS[0].style;

const same = (a: Style, b: Style) => a.risk === b.risk && LEARNERS.every((x) => a.learning[x.key] === b.learning[x.key]);
const bodyOf = (s: Style): StyleBody => ({ learning: s.learning, ...(s.risk !== null ? { risk: s.risk } : {}) });
/** What the create/breed API gets: nothing for Natural, so the fly is simply born with a style. */
export const styleBody = (s: Style): StyleBody | undefined => (same(s, NATURAL) ? undefined : bodyOf(s));

/** Presets, learner switches and risk. The fly's brain still makes every trade; this sets what it starts from. */
export function StylePicker({ value, onChange, naturalHelp }: { value: Style; onChange: (s: Style) => void; naturalHelp?: string }) {
  const preset = PRESETS.find((p) => same(p.style, value))?.key ?? "";
  return (
    <div className="style-picker">
      <div className="profiles style-presets">
        {PRESETS.map((p) => (
          <button type="button" key={p.key} className={`profile${preset === p.key ? " on" : ""}`} onClick={() => onChange(p.style)}>
            <b>{p.label}</b>
            <span>{p.key === "natural" && naturalHelp ? naturalHelp : p.help}</span>
          </button>
        ))}
      </div>
      <div className="learner-list">
        {LEARNERS.map((x) => (
          <label key={x.key} className={`learner${value.learning[x.key] ? " on" : ""}`}>
            <input type="checkbox" checked={value.learning[x.key]}
                   onChange={() => onChange({ ...value, learning: { ...value.learning, [x.key]: !value.learning[x.key] } })} />
            <span><b>{x.label}</b>: {x.note}</span>
          </label>
        ))}
      </div>
      <div className="slider">
        <span className="slider-top">
          <label className="risk-set">
            <input type="checkbox" checked={value.risk !== null} onChange={(e) => onChange({ ...value, risk: e.target.checked ? 0.25 : null })} />
            Set risk per buy
          </label>
          <span className={`mono${value.risk === null ? "" : " changed"}`}>{value.risk === null ? "born with it" : `${Math.round(value.risk * 100)}%`}</span>
        </span>
        {value.risk !== null && (
          <input type="range" min={RISK[0]} max={RISK[1]} step={0.01} value={value.risk} aria-label="risk per buy"
                 onChange={(e) => onChange({ ...value, risk: Number(e.target.value) })} />
        )}
        <small>How much of its fake ETH goes into a buy ({Math.round(RISK[0] * 100)}–{Math.round(RISK[1] * 100)}%).</small>
      </div>
    </div>
  );
}

/** An existing fly's style, changed by its owner; used from the next market round. */
export function StyleEditor({ flyId, learning, risk, onSaved }: {
  flyId: string; learning: Learning; risk: number | null; onSaved?: (s: Style) => void;
}) {
  const [value, setValue] = useState<Style>({ learning, risk });
  const [saved, setSaved] = useState<Style>({ learning, risk });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await setStyle(flyId, bodyOf(value));
      setSaved(value);
      onSaved?.(value);
      setMsg("Saved. It trades this way from the next market round.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="style-editor">
      <StylePicker value={value} onChange={(s) => { setValue(s); setMsg(null); }} naturalHelp="All learners on, and it keeps its current risk." />
      <div className="style-save">
        <button className="btn red" disabled={same(value, saved) || busy} onClick={save}>{busy ? "Saving…" : "Save style"}</button>
        {msg && <span className="fine">{msg}</span>}
      </div>
    </div>
  );
}
