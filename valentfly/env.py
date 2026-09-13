"""Be My ValentFLY -- the domain.

5 candidates, each with a hidden true compatibility score (0-10). Every one
gets dated exactly once, then a single proposal is made. Nothing in this
file decides who to propose to -- that's `season.py`, reading the real fly
brain's live firing (see `encode.py`). This module only holds the rules and
the (purely narrative) scoring of the final proposal.
"""
from __future__ import annotations

import random

NUM_CANDIDATES = 5
MAX_ROUNDS = NUM_CANDIDATES + 1  # 5 dates + 1 propose
COMPAT_MIN, COMPAT_MAX = 0, 10
WRONG_PROPOSAL_BASE_COST = 5.0


def random_problem(rng: random.Random) -> list[int]:
    """A fresh, hidden compatibility score per candidate."""
    return [rng.randint(COMPAT_MIN, COMPAT_MAX) for _ in range(NUM_CANDIDATES)]


def score_proposal(compat: list[int], proposed: int) -> tuple[float, bool]:
    """(reward, correct) for proposing to `proposed` -- narrative only. Nothing
    here feeds back into any decision; the brain already decided by the time
    this is called."""
    best = max(compat)
    correct = compat[proposed] == best
    reward = 0.0 if correct else -(WRONG_PROPOSAL_BASE_COST + (best - compat[proposed]))
    return reward, correct


if __name__ == "__main__":
    rng = random.Random(0)
    for _ in range(5):
        compat = random_problem(rng)
        best = compat.index(max(compat))
        print(f"compat={compat}  true_best=candidate_{best}")
        r, ok = score_proposal(compat, best)
        assert ok and r == 0.0, "proposing to the true best should score correct at zero cost"
        worst = compat.index(min(compat))
        if worst != best:
            r, ok = score_proposal(compat, worst)
            assert not ok and r < 0.0, "proposing to a worse candidate should score wrong at a real cost"
    print("self-test OK")
