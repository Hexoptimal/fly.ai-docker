"""Export Fly Radio for the website: the shows, the stimulus contexts, the wing motor neurons and the caption
readout as one small JSON the browser radio (world/radio.html) loads. The brain itself is the same
`flybrain export --web` files the Simulation page already serves (/simulation/connectome/).

    python radio/export_web.py            # writes world/src/radio/radio.json (bundled into the page)

Re-run it whenever radio/channels.py, flytalk.CONTEXTS / WING_MN or the cached readout (radio/model/) change.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import numpy as np  # noqa: E402

import channels  # noqa: E402
import decode  # noqa: E402
from flytalk import CONTEXTS, NAMES, WING_MN, windows  # noqa: E402

OUT = HERE.parent / "world" / "src" / "radio" / "radio.json"


def main() -> None:
    meta = json.loads(decode.META_PATH.read_text())
    d = np.load(decode.READOUT_PATH, allow_pickle=False)
    dt = float(meta["fingerprint"]["dt"])
    steps = windows(dt)[1]
    P = d["P"]
    if P.shape[0] != steps:
        raise SystemExit(f"readout expects {P.shape[0]} features, the caption window is {steps} steps")
    channels.assign_columns()
    out = {
        "dt": dt,
        "caption_steps": steps,
        "caption_every_s": 2.0,
        "contexts": {name: [{"types": list(types), "amount": amount} for types, amount in CONTEXTS[name]] for name in NAMES},
        "names": NAMES,
        "wing_mn": WING_MN,
        "rest": float(meta["rest"]),
        "readout": {"mu": d["mu"].astype(float).round(6).tolist(), "P": P.astype(float).round(6).tolist(),
                    "sd": d["sd"].astype(float).round(6).tolist(), "w": d["w"].astype(float).round(6).tolist(),
                    "b": np.atleast_1d(d["b"]).astype(float).round(6).tolist(), "cv_score": float(meta["cv_score"]),
                    "trained_at": meta.get("trained_at")},
        "shows": [{"id": s.id, "name": s.name, "tagline": s.tagline, "noise": s.noise,
                   "turn_seconds": list(s.turn_seconds) if s.turn_seconds else None,
                   "cast": [{"role": m.role, "name": m.name, "context": m.context, "pitch": m.pitch, "tone": m.tone}
                            for m in s.cast]} for s in channels.SHOWS],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1000:.1f} KB): {len(out['shows'])} shows, readout {P.shape}")


if __name__ == "__main__":
    main()
