"""Can two connectome flies signal to each other?

    fly A: context -> sensory neurons -> connectome -> wing motor neurons -> "song"
    fly B: song -> Johnston's organ (JO-A/JO-B, the fly's ear) -> connectome -> descending neurons

Both flies are the frozen MaleCNS connectome; each is one column of a batched
FlyBrain (same wiring, own voltages and noise). Nothing between A's wing motor
neurons and B's ear is fitted to the result: the song is A's wing-MN spike count
above rest, and B's ear gain is set from song amplitudes alone, never from labels.

Brain options (see FlyBrain): --dt sets the step (0.020 = run 1; 0.002 can carry pulse
rhythm), --fix-sensory removes synapses onto sensory neurons (without it, olfactory
receptor neurons excite each other into a runaway loop and odours add nothing),
--refractory holds neurons at 0 after a spike.

Contexts, injected into A only, through real sensory types:
    baseline  nothing
    mate      LC10a (the target a male chases)
    threat    LC4 + LPLC2 (looming)
    food      ORN_DM1 + ORN_DM2 (fruit-ester olfactory receptor neurons)

Decided before running (so a negative result stays negative):
  1. Song carries information  -> A's context decodes from A's song above a label-permutation null.
  2. The wiring matters        -> the real connectome's song carries more information than a
                                  degree-preserving rewired copy's.
  3. B hears it                -> B's descending-neuron activity decodes A's context under real
                                  song, and stays at chance under silence.
  4. Structure vs loudness     -> real song vs the same song with its steps shuffled in time,
                                  and (sender side) decoding from the song's spectrum alone.

Song features for decoding are always the loudness envelope in 20 ms bins, so runs at
different step lengths compare directly; the spectrum test is reported separately.

    python flytalk.py pilot
    python flytalk.py run --trials 60                                   # run 1
    python flytalk.py run --trials 40 --dt 0.002 --fix-sensory --refractory 0.002 --out talk-2ms
    python flytalk.py report --out talk-2ms
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
from scipy import sparse

from flybrain.reservoir import Readout, Trace, folds
from flybrain import FlyBrain

ROOT = Path(__file__).parent

WING_MN = ["DLMn a, b", "DLMn c-f", "DVMn 1a-c", "DVMn 2a, b", "DVMn 3a, b", "MNwm35", "MNwm36",
           "b1 MN", "b2 MN", "b3 MN", "hg1 MN", "hg2 MN", "hg3 MN", "hg4 MN", "i1 MN", "i2 MN",
           "iii1 MN", "iii3 MN", "ps1 MN", "tp1 MN", "tp2 MN", "tpn MN"]
EAR_PREFIXES = ("JO-A", "JO-B")
CONTEXTS = {
    "baseline": [],
    "mate": [(["LC10a"], 0.7)],
    "threat": [(["LC4"], 0.8), (["LPLC2"], 0.8)],
    "food": [(["ORN_DM1", "ORN_DM2"], 0.8)],
}
NAMES = list(CONTEXTS)
BEHAVIOUR = ["forward_L", "forward_R", "steer_L", "steer_R", "escape_L", "escape_R", "backward_L", "backward_R"]
WARMUP_S, SONG_S, BIN_S = 0.5, 1.0, 0.020      # settle, context / song, envelope bin for decoding
EAR_CAP = 0.8


def windows(dt: float) -> tuple[int, int]:
    """(warmup steps, song steps) for a step length."""
    return int(round(WARMUP_S / dt)), int(round(SONG_S / dt))


def make_brain(args_or_meta, batch: int, seed: int = 1, device: str = "auto") -> FlyBrain:
    g = (lambda k: args_or_meta[k]) if isinstance(args_or_meta, dict) else (lambda k: getattr(args_or_meta, k))
    return FlyBrain(device=device, batch=batch, seed=seed, dt=float(g("dt")),
                    sensory_input=not bool(g("fix_sensory")), refractory=float(g("refractory")))


def ear_cells(brain) -> np.ndarray:
    types = sorted({str(t) for t in np.unique(brain.cell_type) if str(t).startswith(EAR_PREFIXES)})
    return brain.cells(types)


def rewire(brain, seed: int) -> None:
    """Degree-preserving scramble: each synapse keeps its presynaptic neuron and weight,
    each neuron keeps how many synapses it receives, but who connects to whom is shuffled.
    With the sensory fix on, synapses that land on sensory neurons are removed again."""
    rng = np.random.default_rng(seed)
    brain.indices = rng.permutation(brain.indices).astype(brain.indices.dtype)
    if not brain.sensory_input:
        sensory = np.char.find(brain.superclass.astype(str), "sensory") >= 0
        brain.weights = np.where(sensory[brain.indices], 0, brain.weights).astype(brain.weights.dtype)
    if brain.device == "cuda":
        from cupyx.scipy import sparse as cusparse
        W = sparse.csc_matrix((brain.weights, brain.indices, brain.indptr), shape=(brain.n, brain.n))
        W.sum_duplicates()
        brain._W = cusparse.csr_matrix(W.tocsr().astype(np.float32))


class Counter:
    """Spikes per step in named, disjoint neuron groups, for every fly: (batch, groups)."""

    def __init__(self, brain, groups: dict[str, np.ndarray]):
        self.names = list(groups)
        self.lut = np.full(brain.n, -1, np.int64)
        for i, idx in enumerate(groups.values()):
            if np.any(self.lut[idx] >= 0):
                raise ValueError("groups overlap")
            self.lut[idx] = i

    def __call__(self, fired: list[np.ndarray]) -> np.ndarray:
        out = np.zeros((len(fired), len(self.names)), np.float32)
        for b, f in enumerate(fired):
            g = self.lut[f]
            out[b] = np.bincount(g[g >= 0], minlength=len(self.names))
        return out


def context_injector(brain):
    cells = {c: [(brain.cells(types), amount) for types, amount in parts] for c, parts in CONTEXTS.items()}

    def inject(ctx: np.ndarray) -> list:
        out = []
        for c, name in enumerate(NAMES):
            on = (ctx == c).astype(np.float32)
            if on.any():
                out += [(idx, amount * on) for idx, amount in cells[name]]
        return out

    return inject


def wing_groups(brain) -> dict[str, np.ndarray]:
    wing = brain.cells(WING_MN)
    left, right = wing[brain.side[wing] == "L"], wing[brain.side[wing] == "R"]
    if len(left) == 0 or len(right) == 0:
        return {"L": wing[: len(wing) // 2], "R": wing[len(wing) // 2:]}
    return {"L": left, "R": right, "other": np.setdiff1d(wing, np.concatenate([left, right]))}


def speak(brain, trials: int, seed: int, tag: str) -> dict:
    """Every fly in the batch is a sender, each trial in a balanced random context."""
    B, rng = brain.batch, np.random.default_rng(seed)
    W, S = windows(brain.dt)
    wing = wing_groups(brain)
    count = Counter(brain, {k: v for k, v in wing.items() if len(v)})
    inject = context_injector(brain)
    songs = np.zeros((trials * B, W + S, 2), np.float32)
    labels = np.zeros(trials * B, np.int64)
    rate = np.zeros((trials * B, 2), np.float32)      # all-neuron spikes/s: warmup, context
    t0 = time.perf_counter()
    for t in range(trials):
        ctx = rng.permutation(np.resize(np.arange(len(NAMES)), B))
        rows = slice(t * B, (t + 1) * B)
        labels[rows] = ctx
        brain.reset(seed * 10_000 + t)
        for s in range(W + S):
            fired = brain.step(inject=inject(ctx) if s >= W else ())
            songs[rows, s] = count(fired)[:, :2]
            n = np.array([len(f) for f in fired])
            rate[rows, int(s >= W)] += n / ((S if s >= W else W) * brain.dt)
        if t == 0 or (t + 1) % 10 == 0:
            print(f"  [{tag}] speak trial {t + 1}/{trials}  {(time.perf_counter() - t0) / (t + 1):.1f} s/trial", flush=True)
    return {"songs": songs, "labels": labels, "rate": rate}


def sound_of(songs: np.ndarray, rest: float) -> np.ndarray:
    """Loudness per step: wing-MN spikes above the resting level (resting noise makes no sound)."""
    return np.maximum(songs.sum(-1) - rest, 0.0)


def listen(brain, sound: np.ndarray, labels: np.ndarray, gain: float, trials: int, seed: int) -> dict:
    """Every fly in the batch is a receiver. Each trial, each fly gets one condition:
    real song, the same song shuffled in time, or silence (paired with a song whose label
    it never hears -- the built-in null)."""
    B, rng = brain.batch, np.random.default_rng(seed)
    W, S = windows(brain.dt)
    ear = ear_cells(brain)
    wing = wing_groups(brain)
    groups = {g: brain.groups[g] for g in BEHAVIOUR}
    groups["wing"] = np.concatenate(list(wing.values()))
    count = Counter(brain, groups)
    trace = Trace(brain, types=["descending_neuron"], aggregate="batch")
    n = trials * B
    X = np.zeros((n, len(trace.idx)), np.float32)
    beh = np.zeros((n, len(groups)), np.float32)     # spikes/s per group over the song window
    cond = np.zeros(n, np.int64)
    src = np.zeros(n, np.int64)
    rate = np.zeros(n, np.float32)
    t0 = time.perf_counter()
    for t in range(trials):
        rows = slice(t * B, (t + 1) * B)
        c = rng.permutation(np.resize(np.arange(3), B))
        k = rng.choice(len(sound), B, replace=False)
        heard = sound[k].copy()
        for b in np.flatnonzero(c == 1):             # shuffle the song part only
            heard[b, W:] = rng.permutation(heard[b, W:])
        heard[c == 2] = 0.0
        cond[rows], src[rows] = c, k
        brain.reset(seed * 10_000 + t)
        trace.reset()
        for s in range(W + S):
            amount = np.minimum(gain * heard[:, s - 1], EAR_CAP) if s > 0 else np.zeros(B, np.float32)
            fired = brain.step(inject=[(ear, amount)])
            f = trace.observe(fired)
            if s >= W:
                X[rows] += f.T / S
                beh[rows] += count(fired) / (S * brain.dt)
                rate[rows] += np.array([len(x) for x in fired]) / (S * brain.dt)
        if t == 0 or (t + 1) % 10 == 0:
            print(f"  listen trial {t + 1}/{trials}  {(time.perf_counter() - t0) / (t + 1):.1f} s/trial", flush=True)
    return {"X": X, "beh": beh, "cond": cond, "src": src, "heard_label": labels[src], "rate": rate,
            "beh_names": np.array(list(groups))}


# ---- features and analysis ------------------------------------------------------------------

def envelope(songs: np.ndarray, dt: float) -> np.ndarray:
    """Song window as loudness in 20 ms bins, per wing: (n, bins, 2)."""
    W, S = windows(dt)
    per = max(1, int(round(BIN_S / dt)))
    x = songs[:, W:W + S - S % per]
    return x.reshape(len(songs), -1, per, 2).sum(2)


def song_features(songs: np.ndarray, dt: float = 0.020) -> np.ndarray:
    return envelope(songs, dt).reshape(len(songs), -1)


def spectrum_features(songs: np.ndarray, dt: float) -> tuple[np.ndarray, np.ndarray]:
    """Log amplitude spectrum of the total song (phase-free, so it sees rhythm, not timing).
    Returns (features, frequencies in Hz); the DC term is dropped."""
    W, S = windows(dt)
    x = songs[:, W:W + S].sum(-1)
    x = x - x.mean(1, keepdims=True)
    mag = np.abs(np.fft.rfft(x, axis=1))[:, 1:]
    return np.log1p(mag), np.fft.rfftfreq(S, dt)[1:]


def decode(X: np.ndarray, y: np.ndarray, k: int, seed: int = 0) -> np.ndarray:
    """Nested cross-validated k-way decoding (PCA + ridge on one-hot labels, rank and
    strength chosen inside each training fold). Returns the confusion matrix."""
    rng = np.random.default_rng(seed)
    order = rng.permutation(len(y))
    X, y = X[order], y[order]
    conf = np.zeros((k, k))
    for train, test in folds(len(y), k=5):
        r = Readout.fit(X[train], np.eye(k)[y[train]], kind="ridge", components=(5, 20, 60), lambdas=(0.1, 1.0, 10.0))
        pred = np.argmax(r.predict(X[test]), axis=1)
        np.add.at(conf, (y[test], pred), 1)
    return conf


def info_bits(conf: np.ndarray) -> float:
    p = conf / conf.sum()
    pc, pp = p.sum(1, keepdims=True), p.sum(0, keepdims=True)
    nz = p > 0
    return float(np.sum(p[nz] * np.log2(p[nz] / (pc @ pp)[nz])))


def test(X, y, k, perms: int, seed: int = 0) -> dict:
    conf = decode(X, y, k, seed)
    acc, bits = np.trace(conf) / conf.sum(), info_bits(conf)
    rng = np.random.default_rng(seed + 1)
    null = np.array([np.trace(c) / c.sum() for c in (decode(X, rng.permutation(y), k, seed) for _ in range(perms))])
    return {"accuracy": float(acc), "bits": bits, "chance": 1 / k,
            "null_mean": float(null.mean()), "null_95": float(np.quantile(null, 0.95)),
            "p": float((np.sum(null >= acc) + 1) / (perms + 1)), "confusion": conf.astype(int).tolist()}


# ---- commands --------------------------------------------------------------------------------

def pilot(args) -> None:
    brain = make_brain(args, args.batch, device=args.device)
    W, S = windows(brain.dt)
    wing = wing_groups(brain)
    print(f"dt {brain.dt * 1000:g} ms, sensory input {'on' if brain.sensory_input else 'off'}, refractory {brain.refractory_steps} steps")
    print("wing MNs:", {k: len(v) for k, v in wing.items()}, " ear (JO-A/B):", len(ear_cells(brain)))
    for name, parts in CONTEXTS.items():
        print(f"  context {name}: " + ", ".join(f"{t} x{len(brain.cells(t))} @ {a}" for t, a in parts))
    inject = context_injector(brain)
    types = [str(t) for t in np.unique(brain.cell_type)]
    probes = {"PN DM1/2": brain.cells(["DM1_lPN", "DM2_lPN"]),
              "pC1/P1": brain.cells([t for t in types if t.startswith(("pC1", "P1_"))]),
              "song cmd": brain.cells(["pIP10", "dPR1"] + [t for t in types if t.startswith("TN1")]),
              "DNp01": np.concatenate([brain.groups["escape_L"], brain.groups["escape_R"]]),
              "DNa02": np.concatenate([brain.groups["steer_L"], brain.groups["steer_R"]]),
              "wing MN": np.concatenate(list(wing.values()))}
    lut = np.full(brain.n, -1, np.int64)
    for i, idx in enumerate(probes.values()):
        lut[idx] = np.where(lut[idx] < 0, i, lut[idx])
    half = brain.batch // 2
    for c, name in enumerate(NAMES):
        ctx = np.full(brain.batch, -1)
        ctx[:half] = c
        brain.reset(7)
        tot = np.zeros((2, len(probes)))
        t0 = time.perf_counter()
        for s in range(W + S):
            fired = brain.step(inject=inject(ctx) if s >= W else ())
            if s >= W:
                for h, flies in enumerate((fired[:half], fired[half:])):
                    for f in flies:
                        g = lut[f]
                        tot[h] += np.bincount(g[g >= 0], minlength=len(probes))
        ms = (time.perf_counter() - t0) / (W + S) * 1000
        per = tot / half / SONG_S
        print(f"{name:9s} ({ms:.1f} ms/step): " +
              "  ".join(f"{p} {per[0, i]:.1f}/{per[1, i]:.1f}" for i, p in enumerate(probes)))
    print("(driven / undriven flies, spikes per second summed over each group)")


def run(args) -> None:
    out = ROOT / args.out
    out.mkdir(exist_ok=True)
    meta = {"dt": args.dt, "fix_sensory": args.fix_sensory, "refractory": args.refractory}
    brain = make_brain(args, args.batch, device=args.device)
    W, _ = windows(brain.dt)
    print(f"real connectome, {args.batch} flies per batch, {meta}")
    real = speak(brain, args.trials, seed=1, tag="real")
    rest = float(real["songs"][:, int(round(0.1 / brain.dt)):W].sum(-1).mean())
    sound = sound_of(real["songs"], rest)
    loud = sound[:, W:]
    gain = EAR_CAP / float(np.quantile(loud[loud > 0], 0.9)) if np.any(loud > 0) else 0.0
    print(f"rest {rest:.3f} wing spikes/step, ear gain {gain:.3f} (90th-percentile loudness -> cap {EAR_CAP})")
    np.savez_compressed(out / "real.npz", **real, rest=rest, gain=gain, **meta)
    heard = listen(brain, sound, real["labels"], gain, args.trials, seed=2)
    np.savez_compressed(out / "listen.npz", **heard, **meta)
    rewire(brain, seed=3)
    print("rewired connectome (degree-preserving)")
    fake = speak(brain, args.trials, seed=1, tag="rewired")
    np.savez_compressed(out / "rewired.npz", **fake, **meta)
    report(args)


def report(args) -> None:
    out = ROOT / args.out
    real, fake, heard = (np.load(out / f) for f in ("real.npz", "rewired.npz", "listen.npz"))
    dt = float(real["dt"]) if "dt" in real.files else 0.020
    W, S = windows(dt)
    K = len(NAMES)
    res = {"contexts": NAMES, "songs": int(len(real["labels"])), "dt": dt,
           "fix_sensory": bool(real["fix_sensory"]) if "fix_sensory" in real.files else False,
           "refractory": float(real["refractory"]) if "refractory" in real.files else 0.0}
    print(f"\n=== 0. what the senders did ({len(real['labels'])} songs, dt {dt * 1000:g} ms) ===")
    res["senders"] = {}
    for name, d in (("real", real), ("rewired", fake)):
        for c, ctx in enumerate(NAMES):
            m = d["labels"] == c
            s = d["songs"][m, W:].sum(-1) / dt
            warm = d["songs"][m, int(round(0.1 / dt)):W].sum(-1) / dt
            res["senders"][f"{name}_{ctx}"] = {"wing_hz": float(s.mean()), "warmup_wing_hz": float(warm.mean()),
                                               "all_neurons_hz": float(d["rate"][m, 1].mean())}
            print(f"  {name:8s} {ctx:9s} wing spikes/s {s.mean():7.1f} (warmup {warm.mean():6.1f})"
                  f"  all-neuron spikes/s {d['rate'][m, 1].mean():10.0f}")
    print("\n=== 1-2. does the song carry the sender's context? (envelope, 20 ms bins) ===")
    for name, d in (("real", real), ("rewired", fake)):
        r = test(song_features(d["songs"], dt), d["labels"], K, args.perms)
        res[f"song_{name}"] = r
        print(f"  {name:8s} accuracy {r['accuracy']:.3f} (chance {r['chance']:.2f}, null 95% {r['null_95']:.3f}, p {r['p']:.3f})"
              f"  info {r['bits']:.2f} bits of {np.log2(K):.0f}")
        print("           confusion (rows = true):", r["confusion"])
    X, freqs = spectrum_features(real["songs"], dt)
    r = test(X, real["labels"], K, args.perms)
    res["song_spectrum"] = r
    print(f"\n=== 4a. rhythm: context from the song's spectrum alone (0-{freqs[-1]:.0f} Hz) ===")
    print(f"  spectrum accuracy {r['accuracy']:.3f} (null 95% {r['null_95']:.3f}, p {r['p']:.3f})  info {r['bits']:.2f} bits")
    print("           confusion (rows = true):", r["confusion"])
    peaks = {}
    for c, ctx in enumerate(NAMES):
        spec = X[real["labels"] == c].mean(0)
        band = freqs >= 5
        peaks[ctx] = float(freqs[band][np.argmax(spec[band])])
    res["spectrum_peak_hz"] = peaks
    print("  strongest rhythm (>= 5 Hz) per context:", {k: f"{v:.0f} Hz" for k, v in peaks.items()})
    print("\n=== 3-4b. does the receiver's brain carry the sender's context? ===")
    for c, cname in enumerate(("real song", "shuffled song", "silence")):
        m = heard["cond"] == c
        r = test(heard["X"][m], heard["heard_label"][m], K, args.perms)
        res[f"receiver_{cname.replace(' ', '_')}"] = r
        print(f"  {cname:13s} n={m.sum():4d} accuracy {r['accuracy']:.3f} (null 95% {r['null_95']:.3f}, p {r['p']:.3f})"
              f"  info {r['bits']:.2f} bits")
    print("\n=== receiver behaviour, spikes/s per group (song window) ===")
    names = [str(x) for x in heard["beh_names"]]
    scale = 1.0 if "dt" in heard.files else 50.0          # run 1 stored spikes/step
    print("  " + " " * 26 + "".join(f"{n:>11s}" for n in names))
    rows = [("silence", heard["cond"] == 2)] + [(f"song: {ctx}", (heard["cond"] == 0) & (heard["heard_label"] == c))
                                                 for c, ctx in enumerate(NAMES)] + [("shuffled (all)", heard["cond"] == 1)]
    res["behaviour"] = {}
    for label, m in rows:
        v = heard["beh"][m].mean(0) * scale
        res["behaviour"][label] = dict(zip(names, map(float, v)))
        print(f"  {label:18s} n={m.sum():4d}" + "".join(f"{x:11.2f}" for x in v))
    (out / "results.json").write_text(json.dumps(res, indent=2))
    print(f"\nsaved {out / 'results.json'}")


# ---- follow-up controls (added after run 2, not pre-registered) ----------------------------

def reaction_quantities(beh: np.ndarray, col: dict[str, int]) -> dict[str, np.ndarray]:
    g = lambda name: beh[..., col[name]]
    return {"escape": g("escape_L") + g("escape_R"),
            "forward": g("forward_L") + g("forward_R"),
            "backward": g("backward_L") + g("backward_R"),
            "turn": g("steer_R") - g("steer_L")}


def behaviour_hz(heard) -> np.ndarray:
    return heard["beh"] * (1.0 if "dt" in heard.files else 50.0)      # run 1 stored spikes/step at 20 ms


def silence_reference(heard) -> dict[str, tuple[float, float]]:
    col = {str(n): i for i, n in enumerate(heard["beh_names"])}
    q = reaction_quantities(behaviour_hz(heard)[heard["cond"] == 2], col)
    return {k: (float(v.mean()), float(v.std() + 1e-6)) for k, v in q.items()}


def describe(z: dict[str, float]) -> str:
    """A listener's reaction in words: only quantities more than 2 SD from silence count."""
    said = []
    if z["escape"] > 2:
        said.append("jumped")
    if z["backward"] > 2:
        said.append("backed off")
    if z["forward"] > 2:
        said.append("walked forward")
    if abs(z["turn"]) > 2:
        said.append("turned " + ("right" if z["turn"] > 0 else "left"))
    return ", ".join(said) if said else "heard it, did nothing"


def perm_greater(a: np.ndarray, b: np.ndarray, n: int = 5000, seed: int = 0) -> float:
    """One-sided permutation p that mean(a) > mean(b)."""
    rng = np.random.default_rng(seed)
    both, k = np.concatenate([a, b]), len(a)
    obs = a.mean() - b.mean()
    null = np.array([(lambda x: x[:k].mean() - x[k:].mean())(rng.permutation(both)) for _ in range(n)])
    return float((np.sum(null >= obs) + 1) / (n + 1))


def followup(args) -> None:
    """Controls added after seeing run 2, reported as such:
      * rhythm without loudness: each song's spectrum divided by its own total, so only
        which frequencies carry power is left;
      * loudness alone: one number per song;
      * power in the pulse-interval band (20-40 Hz) and carrier band (100-250 Hz) per context;
      * how often listeners react vs silence, with permutation p-values."""
    out = ROOT / args.out
    real, heard = np.load(out / "real.npz"), np.load(out / "listen.npz")
    step = float(real["dt"]) if "dt" in real.files else 0.020
    W, S = windows(step)
    K = len(NAMES)
    res = {}
    X, freqs = spectrum_features(real["songs"], step)
    mag = np.expm1(X)
    shape = mag / (mag.sum(1, keepdims=True) + 1e-9)
    res["spectrum_shape"] = test(shape, real["labels"], K, args.perms)
    loud = np.log1p(real["songs"][:, W:W + S].sum((1, 2)))[:, None]
    res["loudness_only"] = test(loud, real["labels"], K, args.perms)
    print(f"=== follow-up controls: {args.out} (dt {step * 1000:g} ms, spectrum to {freqs[-1]:.0f} Hz) ===")
    for key in ("spectrum_shape", "loudness_only"):
        r = res[key]
        print(f"  {key:15s} accuracy {r['accuracy']:.3f} (null 95% {r['null_95']:.3f}, p {r['p']:.3f})  {r['bits']:.2f} bits  {r['confusion']}")
    bands = {"pulse 20-40 Hz": (20, 40), "carrier 100-250 Hz": (100, 250)}
    res["band_share"] = {}
    for bname, (lo, hi) in bands.items():
        sel = (freqs >= lo) & (freqs <= hi)
        if not sel.any():
            continue
        share = {ctx: float(shape[real["labels"] == c][:, sel].sum(1).mean()) for c, ctx in enumerate(NAMES)}
        res["band_share"][bname] = share
        print(f"  share of song power in {bname}: " + ", ".join(f"{k} {v:.1%}" for k, v in share.items()))
    col = {str(n): i for i, n in enumerate(heard["beh_names"])}
    sil = silence_reference(heard)
    q = reaction_quantities(behaviour_hz(heard), col)
    z = {k: (v - sil[k][0]) / sil[k][1] for k, v in q.items()}
    words = np.array([describe({k: float(z[k][i]) for k in z}) for i in range(len(heard["cond"]))])
    reacted = words != "heard it, did nothing"
    silence = heard["cond"] == 2
    rows = {"silence": silence, "any real song": heard["cond"] == 0, "shuffled song": heard["cond"] == 1}
    rows.update({f"song: {ctx}": (heard["cond"] == 0) & (heard["heard_label"] == c) for c, ctx in enumerate(NAMES)})
    res["reactions"] = {}
    for name, m in rows.items():
        entry = {"n": int(m.sum()), "reacted": float(reacted[m].mean()), "escape_hz": float(q["escape"][m].mean())}
        if name != "silence":
            entry["p_reacted_vs_silence"] = perm_greater(reacted[m].astype(float), reacted[silence].astype(float))
            entry["p_escape_vs_silence"] = perm_greater(q["escape"][m], q["escape"][silence])
        res["reactions"][name] = entry
        extra = f"  p {entry['p_reacted_vs_silence']:.3f} / {entry['p_escape_vs_silence']:.3f}" if name != "silence" else ""
        print(f"  {name:16s} n={entry['n']:3d} reacted {entry['reacted']:5.1%}  escape {entry['escape_hz']:.2f} Hz{extra}")
    path = out / "results.json"
    full = json.loads(path.read_text()) if path.exists() else {}
    full["followup"] = res
    path.write_text(json.dumps(full, indent=2))
    print(f"saved follow-up into {path}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["pilot", "run", "report", "followup"])
    p.add_argument("--device", default="auto")
    p.add_argument("--batch", type=int, default=12, help="flies stepped together (a multiple of 12 balances contexts and conditions)")
    p.add_argument("--trials", type=int, default=40)
    p.add_argument("--perms", type=int, default=50, help="label permutations for the null")
    p.add_argument("--dt", type=float, default=0.020, help="brain step in seconds")
    p.add_argument("--fix-sensory", action="store_true", help="no synapses onto sensory neurons")
    p.add_argument("--refractory", type=float, default=0.0, help="seconds held at 0 after a spike")
    p.add_argument("--out", default="talk", help="results folder (relative to the repo)")
    args = p.parse_args()
    {"pilot": pilot, "run": run, "report": report, "followup": followup}[args.command](args)


if __name__ == "__main__":
    main()
