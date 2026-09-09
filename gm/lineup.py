"""Optimal starting-lineup solver.

Flex slots make greedy filling wrong in the general case (REC_FLEX and
WRRB_FLEX are not nested), so we solve the assignment exactly with a DP over
a bitmask of filled slots. Rosters are small, so this is instant.
"""
from __future__ import annotations

from dataclasses import dataclass

from .scoring import SLOT_ELIGIBILITY, LeagueRules


@dataclass
class LineupSlot:
    slot: str
    player_id: str | None
    points: float
    note: str = ""


@dataclass
class Lineup:
    slots: list[LineupSlot]
    bench: list[tuple[str, float]]
    total: float

    def starter_ids(self) -> list[str]:
        return [s.player_id for s in self.slots if s.player_id]


def optimize(rules: LeagueRules,
             candidates: dict[str, float],
             positions: dict[str, str],
             *, exclude: set[str] | None = None) -> Lineup:
    """Best legal lineup from `candidates` (player_id -> projected points).

    `positions` maps player_id -> real position. Players that cannot fill any
    starting slot (or are excluded) go to the bench.
    """
    exclude = exclude or set()
    slots = rules.starting_slots
    n_slots = len(slots)

    pool: list[tuple[str, float, int]] = []
    for pid, pts in candidates.items():
        if pid in exclude:
            continue
        pos = positions.get(pid)
        if not pos:
            continue
        mask = 0
        for i, slot in enumerate(slots):
            if pos in SLOT_ELIGIBILITY.get(slot, {slot}):
                mask |= 1 << i
        if mask:
            pool.append((pid, pts, mask))

    # Best players first keeps the DP's useful states dense.
    pool.sort(key=lambda t: -t[1])

    # dp[filled_mask] -> (total_points, [(player_id, slot_index), ...])
    dp: dict[int, tuple[float, list[tuple[str, int]]]] = {0: (0.0, [])}
    for pid, pts, elig in pool:
        nxt = dict(dp)
        for mask, (score, assign) in dp.items():
            free = elig & ~mask
            if not free:
                continue
            for i in range(n_slots):
                bit = 1 << i
                if not (free & bit):
                    continue
                nm = mask | bit
                ns = score + pts
                cur = nxt.get(nm)
                if cur is None or ns > cur[0]:
                    nxt[nm] = (ns, assign + [(pid, i)])
        dp = nxt

    best_mask, (best_score, best_assign) = max(dp.items(), key=lambda kv: kv[1][0])

    filled: dict[int, str] = {i: pid for pid, i in best_assign}
    out_slots = [
        LineupSlot(slot=slots[i],
                   player_id=filled.get(i),
                   points=round(candidates.get(filled.get(i), 0.0) or 0.0, 2))
        for i in range(n_slots)
    ]
    started = set(filled.values())
    bench = sorted(
        ((pid, round(pts, 2)) for pid, pts in candidates.items()
         if pid not in started and pid not in exclude),
        key=lambda t: -t[1],
    )
    return Lineup(slots=out_slots, bench=bench, total=round(best_score, 2))


def lineup_value(rules: LeagueRules, candidates: dict[str, float],
                 positions: dict[str, str], *, exclude: set[str] | None = None) -> float:
    """Just the total of the optimal lineup -- used for marginal-value math."""
    return optimize(rules, candidates, positions, exclude=exclude).total


def marginal_value(rules: LeagueRules, roster_points: dict[str, float],
                   positions: dict[str, str], candidate_id: str,
                   candidate_points: float, candidate_pos: str) -> float:
    """How many points adding this player would add to the optimal lineup.

    This is the number that matters on waivers: a WR3 who never cracks your
    starting lineup is worth zero regardless of his raw projection.
    """
    before = lineup_value(rules, roster_points, positions)
    after_points = dict(roster_points)
    after_points[candidate_id] = candidate_points
    after_positions = dict(positions)
    after_positions[candidate_id] = candidate_pos
    after = lineup_value(rules, after_points, after_positions)
    return round(after - before, 2)
