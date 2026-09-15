"""Show lineup for the fly radio station.

Reuses flytalk.py's already-real stimulus contexts (baseline/mate/threat/food,
each a named real neuron population) almost verbatim -- no new neuron-to-theme
mappings are invented here, just radio-show branding and a cast on top.

    python radio/channels.py   # self-test, no brain needed
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flytalk import CONTEXTS  # noqa: E402  (path insert must come first)


class Member:
    """One fly's seat in the live batch: a role, an on-air name, which
    flytalk.CONTEXTS key stimulates it, a carrier-pitch tweak so distinct
    cast members sound distinguishable, and how much of that carrier tone to
    use at all -- `tone=0` drops it entirely, leaving just real-envelope-driven
    noise (radio static), for a column with nothing being asked of it
    (see radio/audio.py's Voice)."""

    def __init__(self, role: str, name: str, context: str, pitch: float = 1.0, tone: float = 1.0):
        if context not in CONTEXTS:
            raise ValueError(f"unknown context {context!r}, must be one of {list(CONTEXTS)}")
        self.role, self.name, self.context, self.pitch, self.tone = role, name, context, pitch, tone
        self.column: int | None = None  # batch column, assigned by assign_columns()


class Show:
    """One channel. `turn_seconds`, if set, is (seconds cast[0] is on-mic,
    seconds cast[1] is on-mic) -- the presenter/expert turn-taking loop."""

    def __init__(self, id: str, name: str, tagline: str, cast: list[Member],
                 turn_seconds: tuple[float, float] | None = None, noise: float = 0.03):
        if turn_seconds is not None and len(cast) != 2:
            raise ValueError(f"{id}: turn_seconds needs exactly 2 cast members, got {len(cast)}")
        self.id, self.name, self.tagline, self.cast = id, name, tagline, cast
        self.turn_seconds, self.noise = turn_seconds, noise


SHOWS = [
    Show("static", "White Noise", "Nothing on the line. Just the resting hiss of an undriven fly brain.",
         [Member("fly", "Nobody", "baseline", pitch=1.0, tone=0.0)], noise=0.45),

    Show("buzzkill", "Buzzkill", "True crime, fly-sized. Tonight: something is looming.",
         [Member("fly", "The Suspect", "threat", pitch=0.85)], noise=0.05),

    Show("rotten-and-tasty", "Rotten and Tasty", "One fly, one plate, zero chill.",
         [Member("fly", "The Critic", "food", pitch=1.1)], noise=0.03),

    Show("mating-call", "The Mating Call", "Buzzy Buzz asks. Dr. Buzziam Buzz answers.",
         [Member("presenter", "Buzzy Buzz", "baseline", pitch=1.15),
          Member("expert", "Dr. Buzziam Buzz", "mate", pitch=0.9)],
         turn_seconds=(2.5, 4.0), noise=0.03),
]


def assign_columns() -> list[Member]:
    """Flattens every show's cast into the batch columns a FlyBrain(batch=N)
    needs. Returns the members in column order; also stamps `.column` on each."""
    cast = [m for show in SHOWS for m in show.cast]
    for i, m in enumerate(cast):
        m.column = i
    return cast


def by_id(show_id: str) -> Show:
    for show in SHOWS:
        if show.id == show_id:
            return show
    raise KeyError(show_id)


def show_for_column(column: int) -> Show:
    for show in SHOWS:
        if any(m.column == column for m in show.cast):
            return show
    raise KeyError(column)


if __name__ == "__main__":
    cast = assign_columns()
    assert len(cast) == sum(len(s.cast) for s in SHOWS)
    assert len({m.column for m in cast}) == len(cast), "batch columns must be unique"
    for m in cast:
        assert m.context in CONTEXTS
        assert show_for_column(m.column).id in {s.id for s in SHOWS}
    ids = {s.id for s in SHOWS}
    assert ids == {"static", "buzzkill", "rotten-and-tasty", "mating-call"}, ids
    print(f"self-test OK: {len(SHOWS)} shows, {len(cast)} batch columns")
    for show in SHOWS:
        cast_desc = ", ".join(f"{m.name} ({m.context}, col {m.column})" for m in show.cast)
        turns = f"  turns={show.turn_seconds}" if show.turn_seconds else ""
        print(f"  {show.id:16s} {show.name:16s} {cast_desc}{turns}")
