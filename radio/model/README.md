# radio/model

Holds the cached caption readout `radio/decode.py`'s `calibrate_cached()` reads on startup, so a
redeployed or restarted station doesn't have to recalibrate from scratch (1-2 minutes) before its
first listener hears anything. Mirrors `flybook/worker/model/translator.npz`.

- `readout.npz` -- the fitted `flybrain.reservoir.Readout` (`Readout.save()`/`.load()`). Force-included
  in `.gitignore` despite the blanket `*.npz` rule, same reasoning as the flybook translator: it's
  small and the deployed image needs it.
- `readout.json` -- the fingerprint it was trained with (`decode.fingerprint()`: CONTEXTS, dt, trials,
  seed, `CALIBRATION_VERSION`) plus `rest`, `cv_score` and `trained_at`. `calibrate_cached()` compares
  this against the current fingerprint and recalibrates instead of using a stale cache.

**Generate or refresh it** (needed once before the first deploy, and again whenever
`flytalk.CONTEXTS`, `radio/decode.py`'s calibration logic, or `--dt`/`--calibration-trials` change):

```
python radio/decode.py --cache
```

`radio/server.py` also writes this cache on its own the first time it calibrates fresh (default
behaviour; pass `--no-cache` to skip reading/writing it, or `--recalibrate` to force a fresh run and
overwrite what's here).
