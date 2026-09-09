"""Value over replacement, computed from the league's own starting requirements.

Raw projected points rank QBs at the top of every list. What actually matters
is the surplus over the freely-available alternative at that position, and the
replacement level depends on how many of each position the league starts.
"""
from __future__ import annotations

from dataclasses import dataclass

from .players import PlayerIndex
from .scoring import SLOT_ELIGIBILITY, LeagueRules

# Share of flex slots historically absorbed by each position.
FLEX_SHARE = {"RB": 0.45, "WR": 0.45, "TE": 0.10, "QB": 1.0}


def starters_by_position(rules: LeagueRules) -> dict[str, float]:
    """Expected number of each position started league-wide, per team."""
    counts: dict[str, float] = {}
    for slot in rules.starting_slots:
        elig = SLOT_ELIGIBILITY.get(slot, {slot})
        if len(elig) == 1:
            pos = next(iter(elig))
            counts[pos] = counts.get(pos, 0.0) + 1.0
        else:
            # Split flex slots across eligible positions by typical usage.
            weights = {p: FLEX_SHARE.get(p, 1.0 / len(elig)) for p in elig}
            total = sum(weights.values()) or 1.0
            for p, w in weights.items():
                counts[p] = counts.get(p, 0.0) + w / total
    return counts


@dataclass
class ReplacementLevels:
    by_position: dict[str, float]
    rank_used: dict[str, int]

    def of(self, position: str) -> float:
        return self.by_position.get(position, 0.0)


def replacement_levels(rules: LeagueRules, projections: dict[str, float],
                       players: PlayerIndex, *, bench_depth: float = 0.5
                       ) -> ReplacementLevels:
    """Points produced by the last startable player at each position.

    Replacement rank = (teams x starters at that position), nudged by a bench
    allowance so it reflects what is realistically available, not the very
    last starter.
    """
    per_team = starters_by_position(rules)
    by_pos: dict[str, list[float]] = {}
    for pid, pts in projections.items():
        p = players.get(pid)
        if not p or not p.position:
            continue
        by_pos.setdefault(p.position, []).append(pts)

    levels: dict[str, float] = {}
    ranks: dict[str, int] = {}
    for pos, pts_list in by_pos.items():
        need = per_team.get(pos, 0.0)
        if need <= 0:
            continue
        rank = max(1, int(round(rules.num_teams * (need + bench_depth))))
        pts_list.sort(reverse=True)
        idx = min(rank, len(pts_list)) - 1
        levels[pos] = round(pts_list[idx], 2)
        ranks[pos] = rank
    return ReplacementLevels(levels, ranks)


def vor(projections: dict[str, float], players: PlayerIndex,
        levels: ReplacementLevels) -> dict[str, float]:
    """Value over replacement for every projected player."""
    out: dict[str, float] = {}
    for pid, pts in projections.items():
        p = players.get(pid)
        if not p or not p.position:
            continue
        if p.position not in levels.by_position:
            continue
        out[pid] = round(pts - levels.of(p.position), 2)
    return out
