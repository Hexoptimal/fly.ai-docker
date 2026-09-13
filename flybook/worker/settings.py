"""What an owner can change about their fly.

Shared by the tick (applies it), the API (validates it and serves it as /config) and the app
(builds its controls from /config). Everything is per fly, one column of a batched brain, so
flies with different settings still run together.

Ranges were measured on the brain on 2026-09-13 (ROADMAP section 10): below 0.9x excitability,
or with no background noise, the brain goes silent; inside these ranges it stays active without
running away. What a setting does to a fly's posts is the experiment, not a promise.
"""
from __future__ import annotations

import math
import random

# stimulus word -> the sense that carries it into the brain
SENSE_OF = {"threat": "eyes", "mate": "eyes", "wind": "antennae", "taste": "taste", "touch": "touch", "cva": "smell"}

SENSE_RANGE = (0.0, 2.0)
SENSES = [
    {"key": "eyes", "label": "Eyes", "help": "Looming shapes and moving flies (LC4, LPLC2, LC10a)."},
    {"key": "antennae", "label": "Antennae", "help": "Wind and air movement (Johnston's organ)."},
    {"key": "smell", "label": "Smell", "help": "cVA, the male pheromone (ORN_DA1)."},
    {"key": "taste", "label": "Taste", "help": "Taste neurons in the mouth."},
    {"key": "touch", "label": "Touch", "help": "Bristles around the eyes."},
]

TEMPERAMENT = [
    {"key": "excitability", "label": "Excitability", "min": 0.9, "max": 1.2,
     "help": "Resting drive on every neuron. Lower is calmer; 1.2x is about twice as active."},
    {"key": "wiring", "label": "Synapse strength", "min": 0.7, "max": 1.3,
     "help": "Scales every synapse in the connectome at once."},
    {"key": "restlessness", "label": "Restlessness", "min": 0.5, "max": 3.0,
     "help": "Random background spikes. The brain needs some to be active at all."},
]

# per-step voltage pushed into the group: off holds it below threshold, boost is a steady push
DIAL_LEVELS = {"off": -2.0, "normal": 0.0, "boost": 0.3}
DIALS = [
    {"key": "escape", "label": "Escape jump", "cells": ["DNp01"], "prefix": [], "help": "The giant fibre, 2 neurons."},
    {"key": "backward", "label": "Backing up", "cells": ["MDN"], "prefix": [], "help": "Moonwalker neurons, 4."},
    {"key": "steering", "label": "Steering", "cells": ["DNa02"], "prefix": [], "help": "Turning, 2 neurons."},
    {"key": "grooming", "label": "Grooming", "cells": [], "prefix": ["DNg12"], "help": "DNg12, 39 neurons."},
    {"key": "song", "label": "Song", "cells": ["pIP10"], "prefix": [], "help": "Song command, 2 neurons."},
    {"key": "courtship", "label": "Courtship drive", "cells": [], "prefix": ["pC1"], "help": "pC1, 156 neurons."},
    {"key": "arousal", "label": "Arousal", "cells": [], "prefix": ["OA-VUM"], "help": "Octopamine neurons, 13."},
    {"key": "reward", "label": "Reward", "cells": [], "prefix": ["PAM"], "help": "PAM dopamine, 316 neurons. Already near its top rate in this model, so only off changes much."},
]

PRESETS = [
    {"key": "standard", "label": "Standard", "help": "The connectome exactly as mapped. The baseline to compare against.",
     "settings": {}},
    {"key": "sentinel", "label": "Sentinel", "help": "Sharp eyes and antennae, arousal pushed. Built to notice things.",
     "settings": {"senses": {"eyes": 2.0, "antennae": 1.5}, "dials": {"arousal": "boost"}}},
    {"key": "fearless", "label": "Fearless", "help": "Escape jump switched off and dimmer eyes.",
     "settings": {"dials": {"escape": "off"}, "senses": {"eyes": 0.6}}},
    {"key": "jumpy", "label": "Jumpy", "help": "Excitable and restless, with sharp eyes.",
     "settings": {"temperament": {"excitability": 1.15, "restlessness": 2.0}, "senses": {"eyes": 1.5}}},
    {"key": "romantic", "label": "Romantic", "help": "Courtship drive and song pushed, keen sense of smell.",
     "settings": {"dials": {"courtship": "boost", "song": "boost"}, "senses": {"smell": 1.5}}},
    {"key": "foodie", "label": "Foodie", "help": "Taste doubled, smell up.",
     "settings": {"senses": {"taste": 2.0, "smell": 1.3}}},
    {"key": "neat", "label": "Neat freak", "help": "Grooming pushed, sensitive bristles.",
     "settings": {"dials": {"grooming": "boost"}, "senses": {"touch": 1.5}}},
    {"key": "zen", "label": "Zen", "help": "Calmer resting drive, little background noise.",
     "settings": {"temperament": {"excitability": 0.95, "restlessness": 0.7}}},
    {"key": "hothead", "label": "Hothead", "help": "Excitable, strong synapses, arousal pushed and no escape.",
     "settings": {"temperament": {"excitability": 1.2, "wiring": 1.2}, "dials": {"arousal": "boost", "escape": "off"}}},
    {"key": "couch", "label": "Couch potato", "help": "Low drive, quiet, steering and backing up switched off.",
     "settings": {"temperament": {"excitability": 0.9, "restlessness": 0.5}, "dials": {"steering": "off", "backward": "off"}}},
    {"key": "moonwalker", "label": "Moonwalker", "help": "Backing up and steering pushed.",
     "settings": {"dials": {"backward": "boost", "steering": "boost"}}},
    {"key": "chaos", "label": "Chaos", "help": "Maximum noise, strong synapses, raised drive.",
     "settings": {"temperament": {"restlessness": 3.0, "wiring": 1.3, "excitability": 1.1}}},
    {"key": "numb", "label": "Numb", "help": "Every sense at 0.3x. Barely feels anything.",
     "settings": {"senses": {k["key"]: 0.3 for k in SENSES}}},
]


def _number(x) -> float | None:
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return None
    x = float(x)
    return x if math.isfinite(x) else None


def clean(raw, strict: bool = False) -> dict:
    """Normalise settings to {senses, temperament, dials}, keeping only non-default values.
    strict: raise ValueError on anything invalid (API); otherwise clamp or drop it (tick)."""
    raw = raw if isinstance(raw, dict) else {}
    out: dict = {"senses": {}, "temperament": {}, "dials": {}}

    def fail(message: str) -> None:
        if strict:
            raise ValueError(message)

    for group, spec in (("senses", SENSES), ("temperament", TEMPERAMENT)):
        given = raw.get(group) or {}
        if not isinstance(given, dict):
            fail(f"{group} must be an object")
            continue
        for item in spec:
            if item["key"] not in given:
                continue
            lo, hi = SENSE_RANGE if group == "senses" else (item["min"], item["max"])
            value = _number(given[item["key"]])
            if value is None:
                fail(f"{item['label']} must be a number")
                continue
            if not lo <= value <= hi:
                fail(f"{item['label']} must be between {lo:g} and {hi:g}")
                value = min(max(value, lo), hi)
            if abs(value - 1.0) > 1e-6:
                out[group][item["key"]] = round(value, 3)

    given = raw.get("dials") or {}
    if not isinstance(given, dict):
        fail("dials must be an object")
        given = {}
    for dial in DIALS:
        level = given.get(dial["key"], "normal")
        if level not in DIAL_LEVELS:
            fail(f"{dial['label']} must be one of {', '.join(DIAL_LEVELS)}")
            continue
        if level != "normal":
            out["dials"][dial["key"]] = level
    return out


MUTATION_RATE = 0.3     # chance each slider value mutates when breeding
MUTATION_SD = 0.1       # size of a slider mutation, as a share of that slider's range
DIAL_MUTATION = 0.08    # chance each neuron dial flips to a random level


def breed(a: dict, b: dict, rng: random.Random) -> dict:
    """A child's settings: each value from one parent at random, then small random mutations."""
    a, b = clean(a), clean(b)
    child: dict = {"senses": {}, "temperament": {}, "dials": {}}
    for group, spec in (("senses", SENSES), ("temperament", TEMPERAMENT)):
        for item in spec:
            lo, hi = SENSE_RANGE if group == "senses" else (item["min"], item["max"])
            value = (a if rng.random() < 0.5 else b)[group].get(item["key"], 1.0)
            if rng.random() < MUTATION_RATE:
                value += rng.gauss(0.0, MUTATION_SD * (hi - lo))
            value = round(min(max(value, lo), hi), 2)
            if abs(value - 1.0) > 1e-6:
                child[group][item["key"]] = value
    for dial in DIALS:
        level = (a if rng.random() < 0.5 else b)["dials"].get(dial["key"], "normal")
        if rng.random() < DIAL_MUTATION:
            level = rng.choice(list(DIAL_LEVELS))
        if level != "normal":
            child["dials"][dial["key"]] = level
    return child


def public_spec() -> dict:
    return {
        "senses": SENSES, "sense_range": list(SENSE_RANGE), "temperament": TEMPERAMENT,
        "dials": [{k: d[k] for k in ("key", "label", "help")} for d in DIALS],
        "dial_levels": list(DIAL_LEVELS), "presets": PRESETS,
    }
