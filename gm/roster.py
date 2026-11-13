"""Roster legality: who comes off IR, who goes on it, and who gets cut.

Sleeper blocks adds while a roster is over its limit, and an IR slot holding a
player who no longer qualifies freezes the roster entirely. So before any other
advice can be acted on, the roster has to be legal. Parking a player on IR costs
nothing, so that always comes before cutting anyone.

Mirrors `planRosterFix` in docs/advice.js.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field

from .lineup import lineup_value, optimize

# Designations that keep a player out for weeks. Worth parking on IR whenever a
# slot is free, since the bench spot is pure gain.
LONG_TERM = {"IR", "PUP", "Sus", "NA", "DNR"}


@dataclass
class Cut:
    player_id: str
    name: str
    position: str
    cost: float                 # ROS lineup points lost
    cost_week: float            # this week's lineup points lost
    projection_ros: float
    starts_now: bool
    replaced_by: list[str] = field(default_factory=list)
    next_name: str = ""
    next_cost: float = 0.0


@dataclass
class RosterFix:
    limit: int
    active_count: int
    over_by: int
    open_ir: int
    activate: list[str]
    to_ir: list[str]
    drops: list[Cut]

    @property
    def needed(self) -> bool:
        return bool(self.activate or self.to_ir or self.drops)


def _plain(players, pid: str) -> str:
    p = players.get(pid)
    return p.name if p else pid


def clone_team(team):
    """A detached copy of a team that moves can be applied to."""
    return dataclasses.replace(team, players=list(team.players),
                               starters=list(team.starters),
                               reserve=list(team.reserve), taxi=list(team.taxi))


def apply_moves(team, *, to_ir=(), activate=(), drop=(), add=()):
    """Apply moves to a cloned team in place. Removed starters leave '0'."""
    def vacate(pid):
        if pid in team.starters:
            team.starters[team.starters.index(pid)] = "0"
    for pid in activate:
        team.reserve = [p for p in team.reserve if p != pid]
    for pid in to_ir:
        if pid not in team.reserve:
            team.reserve.append(pid)
        vacate(pid)
    for pid in drop:
        team.players = [p for p in team.players if p != pid]
        team.reserve = [p for p in team.reserve if p != pid]
        vacate(pid)
    for pid in add:
        if pid not in team.players:
            team.players.append(pid)
    return team


def plan_roster_fix(state, team, ros: dict[str, float],
                    week_pts: dict[str, float]) -> RosterFix:
    rules = state.rules
    players = state.players
    eligible_ir = rules.ir_eligible

    def status(pid):
        p = players.get(pid)
        return (p.injury_status or "") if p else ""

    # A player parked on IR who has been cleared has to come off first.
    activate = [pid for pid in team.reserve
                if players.get(pid) and status(pid) not in eligible_ir]
    parked = [p for p in team.reserve if p not in activate]
    active = list(team.active_players()) + activate
    open_ir = max(0, rules.reserve_slots - len(parked))
    limit = rules.roster_size
    over = len(active) - limit

    # Out longest first, then least use this week. Someone merely Out this
    # week is only parked when a spot is genuinely needed.
    cands = sorted((pid for pid in active if status(pid) in eligible_ir),
                   key=lambda p: (status(p) not in LONG_TERM, week_pts.get(p, 0.0)))
    to_ir: list[str] = []
    for pid in cands:
        if len(to_ir) >= open_ir:
            break
        if status(pid) in LONG_TERM or over - len(to_ir) > 0:
            to_ir.append(pid)
    over -= len(to_ir)

    drops: list[Cut] = []
    if over > 0:
        ids = [p for p in active if p not in to_ir]
        pts = {p: ros.get(p, 0.0) for p in ids}
        wk = {p: week_pts.get(p, 0.0) for p in ids}
        positions = state.positions_map(ids)
        for _ in range(over):
            base_ros = lineup_value(rules, pts, positions)
            base_wk = lineup_value(rules, wk, positions)
            starting = set(optimize(rules, wk, positions).starter_ids())
            ranked = []
            for pid in pts:
                p = players.get(pid)
                ranked.append(Cut(
                    player_id=pid, name=p.name if p else pid,
                    position=p.position if p else "?",
                    cost=round(base_ros - lineup_value(rules, pts, positions, exclude={pid}), 2),
                    cost_week=round(base_wk - lineup_value(rules, wk, positions, exclude={pid}), 2),
                    projection_ros=round(pts[pid], 2),
                    starts_now=pid in starting,
                ))
            ranked.sort(key=lambda c: (c.starts_now, c.cost, c.cost_week, c.projection_ros))
            if not ranked:
                break
            pick = ranked[0]
            if len(ranked) > 1:
                pick.next_name, pick.next_cost = ranked[1].name, ranked[1].cost
            before = set(optimize(rules, pts, positions).starter_ids())
            after = optimize(rules, pts, positions, exclude={pick.player_id}).starter_ids()
            pick.replaced_by = [_plain(players, p) for p in after if p not in before]
            drops.append(pick)
            pts.pop(pick.player_id)
            wk.pop(pick.player_id)

    return RosterFix(limit=limit, active_count=len(active) - len(activate),
                     over_by=max(0, len(active) - len(activate) - limit),
                     open_ir=open_ir, activate=activate, to_ir=to_ir, drops=drops)
