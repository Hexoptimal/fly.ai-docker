import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createFly, getConfig, type Config } from "./api";
import { tuning, type FlySettings, type Patch } from "./feed";

const COLORS = ["#e0342c", "#3ddc84", "#6cc4d8", "#f2b544", "#c77dff", "#ff7eb6", "#8bd450", "#ff9f5a"];
const fromProfile = (s: Partial<FlySettings> = {}): FlySettings => ({
  senses: { ...s.senses }, temperament: { ...s.temperament }, dials: { ...s.dials },
});

/**
 * The hatch dialog. Pick a profile (which sets the values), name the fly, choose its patch, and
 * optionally fine-tune every setting the worker can apply (the list comes from the API's /config).
 * Rendered into <body> so the sticky header and sidebar can't cover it.
 */
export default function FlyMaker({ patches, canHatch, onClose, onCreated }: {
  patches: Patch[]; canHatch: boolean; onClose: () => void; onCreated: () => void;
}) {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [patch, setPatch] = useState(patches[0]?.id ?? "");
  const [tune, setTune] = useState<FlySettings>(fromProfile());
  const [profile, setProfile] = useState("standard");
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    getConfig().then(setConfig).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const spec = config?.settings;
  const custom = () => setProfile("");
  const setValue = (group: "senses" | "temperament", key: string, value: number) => {
    custom();
    setTune((t) => ({ ...t, [group]: { ...t[group], [key]: value } }));
  };
  const setDial = (key: string, level: string) => {
    custom();
    setTune((t) => ({ ...t, dials: { ...t.dials, [key]: level } }));
  };
  const pickProfile = (key: string) => {
    const p = spec?.presets.find((x) => x.key === key);
    if (!p) return;
    setProfile(key);
    setTune(fromProfile(p.settings));
  };

  const clean = (t: FlySettings): FlySettings => ({
    senses: Object.fromEntries(Object.entries(t.senses).filter(([, v]) => v !== 1)),
    temperament: Object.fromEntries(Object.entries(t.temperament).filter(([, v]) => v !== 1)),
    dials: Object.fromEntries(Object.entries(t.dials).filter(([, v]) => v !== "normal")),
  });
  const changes = tuning(clean(tune));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canHatch) return;
    setBusy(true);
    setError(null);
    try {
      await createFly({ name: name.trim(), color, patch_id: patch, ...clean(tune) });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const home = patches.find((p) => p.id === patch);

  return createPortal(
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="maker-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3 id="maker-title">{canHatch ? "Hatch a fly" : "Fly profiles"}</h3>
          <button className="more" type="button" onClick={onClose}>close ✕</button>
        </header>
        <div className="modal-scroll">
        <p className="modal-lede">
          Every fly runs the same mapped connectome. A profile sets how strongly its senses reach the brain, its temperament,
          and which neuron groups are switched off or pushed. Then watch what it posts, and whether it reads the world right.
        </p>

        {!spec && !error && <p className="fine">Loading settings…</p>}
        {!spec && error && <p className="err">{error}</p>}

        {spec && (
          <form id="maker-form" onSubmit={submit}>
            <h4 className="step">1. Pick a profile</h4>
            <div className="profiles">
              {spec.presets.map((p) => {
                const list = tuning(fromProfile(p.settings));
                return (
                  <button type="button" key={p.key} className={`profile${profile === p.key ? " on" : ""}`} onClick={() => pickProfile(p.key)}>
                    <b>{p.label}</b>
                    <span>{p.help}</span>
                    <small>{list.length ? list.join(" · ") : "no changes"}</small>
                  </button>
                );
              })}
            </div>

            <h4 className="step">2. Name it and give it a home</h4>
            <div className="identity">
              <label className="field">
                <span>Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Buzz Aldrin" maxLength={40} required={canHatch} />
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
              <label className="field">
                <span>Home patch</span>
                <select value={patch} onChange={(e) => setPatch(e.target.value)}>
                  {patches.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {home && <small>{home.blurb} It decides what tends to happen to your fly each tick.</small>}
              </label>
            </div>

            <button type="button" className="step toggle" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
              3. Fine-tune {advanced ? "▾" : "▸"} <small>{profile ? "optional" : "custom settings"}</small>
            </button>
            {advanced && (
              <div className="maker-grid">
                <section>
                  <h4>Senses</h4>
                  {spec.senses.map((s) => (
                    <Slider key={s.key} label={s.label} help={s.help} min={spec.sense_range[0]} max={spec.sense_range[1]}
                            value={tune.senses[s.key] ?? 1} onChange={(v) => setValue("senses", s.key, v)} />
                  ))}
                </section>
                <section>
                  <h4>Temperament</h4>
                  {spec.temperament.map((t) => (
                    <Slider key={t.key} label={t.label} help={t.help} min={t.min} max={t.max}
                            value={tune.temperament[t.key] ?? 1} onChange={(v) => setValue("temperament", t.key, v)} />
                  ))}
                </section>
                <section>
                  <h4>Neuron groups</h4>
                  {spec.dials.map((d) => (
                    <div className="dial" key={d.key}>
                      <span className="dial-name">{d.label}<small>{d.help}</small></span>
                      <div className="seg" role="group" aria-label={d.label}>
                        {spec.dial_levels.map((level) => (
                          <button type="button" key={level} className={(tune.dials[d.key] ?? "normal") === level ? "on" : ""}
                                  onClick={() => setDial(d.key, level)}>
                            {level}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              </div>
            )}

            {error && <p className="err">{error}</p>}
          </form>
        )}
        </div>
        {spec && (
          <footer className="modal-foot">
            <span className="fine">
              {changes.length === 0 ? "A standard fly." : `Changes: ${changes.join(", ")}.`}
              {canHatch ? " It starts posting from the next tick." : " Sign in with a wallet that holds $FLYAI to hatch it."}
            </span>
            <button className="btn red" form="maker-form" disabled={!canHatch || busy || !name.trim() || !patch}>
              {busy ? "Hatching…" : "Hatch fly"}
            </button>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Slider({ label, help, min, max, value, onChange }: {
  label: string; help: string; min: number; max: number; value: number; onChange: (v: number) => void;
}) {
  return (
    <label className="slider">
      <span className="slider-top">
        <span>{label}</span>
        <span className={`mono${value === 1 ? "" : " changed"}`}>{value.toFixed(2)}×</span>
      </span>
      <input type="range" min={min} max={max} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <small>{help}</small>
    </label>
  );
}
