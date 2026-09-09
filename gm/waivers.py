"""Waiver-wire and free-agent recommendations.

Ranked by marginal points added to YOUR optimal lineup, not by raw projection --
a player who never cracks your starting lineup is worth zero.

Recommendations are also de-conflicted. Three defenses that each want the same
bench spot are not three moves; they are one move with two fallbacks. We find
that out by committing the best claim and re-scoring everything against the
roster that results, rather than by guessing at overlap rules.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .league import LeagueState
from .lineup import lineup_value, optimize
from .scoring import SLOT_ELIGIBILITY
from .value import ReplacementLevels, vor

# Streaming positions never deserve real budget: they are replaced weekly and
# the next-best option is nearly as good.
POSITION_BID_CAP = {"K": 0.05, "DEF": 0.08}

# Ceiling on any single bid so one claim can't consume the whole season.
MAX_BID_PCT = 0.6

# After the top claim is committed, a candidate that keeps less than this share
# of its value was competing for the same job -- it's an alternative, not a
# second move.
ALTERNATIVE_RETENTION = 0.4

# Below this, a claim isn't worth a roster spot.
MIN_MARGINAL = 0.5

# Only the strongest candidates justify the cost of solving for a drop.
DROP_SEARCH_WIDTH = 15


@dataclass
class WaiverTarget:
    player_id: str
    name: str
    position: str
    team: str | None
    projection_ros: float
    marginal_ros: float          # points added to your lineup, rest of season
    marginal_week: float         # points added this week
    drop_id: str | None
    drop_name: str
    drop_cost: float             # ROS lineup value lost by dropping
    net_gain: float              # marginal_ros - drop_cost
    faab_bid: int
    faab_pct: float
    trending_adds: int
    rationale: str
    # Step-by-step justification, shown when the user asks "why?"
    reasoning: list[dict] = field(default_factory=list)
    # Claims that would fill the same job. Only one of these can happen.
    alternatives: list["WaiverTarget"] = field(default_factory=list)


@dataclass
class DropCandidate:
    player_id: str
    name: str
    position: str
    cost: float                  # ROS lineup points lost by dropping them
    projection_ros: float
    starts_now: bool = False     # in your current-week optimal lineup


def _rank_drops(rules, roster_pts: dict[str, float], positions: dict[str, str],
                players, starting_now: set[str], limit: int,
                include_starters: bool) -> list[DropCandidate]:
    """Cheapest players to cut from an arbitrary roster state."""
    base = lineup_value(rules, roster_pts, positions)
    out: list[DropCandidate] = []
    for pid in roster_pts:
        without = lineup_value(rules, roster_pts, positions, exclude={pid})
        p = players.get(pid)
        out.append(DropCandidate(
            player_id=pid,
            name=p.label() if p else pid,
            position=p.position if p else "?",
            cost=round(base - without, 2),
            projection_ros=round(roster_pts.get(pid, 0.0), 2),
            starts_now=pid in starting_now,
        ))
    # Never lead with someone you are starting this week.
    out.sort(key=lambda d: (d.starts_now, d.cost, d.projection_ros))
    if not include_starters:
        safe = [d for d in out if not d.starts_now]
        if safe:
            out = safe
    return out[:limit]


def drop_candidates(state: LeagueState, ros: dict[str, float],
                    limit: int = 8, *,
                    week_pts: dict[str, float] | None = None,
                    include_starters: bool = False) -> list[DropCandidate]:
    """Roster players whose removal costs the least lineup value.

    Rest-of-season cost can read 0.0 for someone who is nonetheless in this
    week's starting lineup (a replacement absorbs the role later in the year).
    Recommending that player as a safe drop is actively harmful, so anyone
    starting this week is flagged and, by default, held back.
    """
    me = state.me
    if not me:
        return []
    roster_pts = state.roster_projection(me, ros)
    positions = state.positions_map(roster_pts)

    starting_now: set[str] = set()
    if week_pts is not None:
        wk = {pid: week_pts.get(pid, 0.0) for pid in me.active_players()}
        starting_now = set(optimize(state.rules, wk, positions).starter_ids())

    return _rank_drops(state.rules, roster_pts, positions, state.players,
                       starting_now, limit, include_starters)


def _faab_bid(rules, net_gain: float, budget_left: int, weeks_left: int,
              trending: int, is_must_add: bool, position: str = "",
              filling_empty_slot: bool = False) -> tuple[int, float]:
    """Bid sizing: scale value against remaining budget, then adjust for demand."""
    if not rules.uses_faab or budget_left <= 0 or net_gain <= 0:
        return 0, 0.0

    # Points-per-remaining-week is the honest unit of value.
    per_week = net_gain / max(1, weeks_left)
    # ~3 pts/wk of lineup improvement is a strong add; scale to ~50% of budget.
    pct = min(0.85, (per_week / 3.0) * 0.5)

    # Competition: heavy league-wide adds mean you must pay up.
    if trending > 100_000:
        pct *= 1.6
    elif trending > 30_000:
        pct *= 1.3
    elif trending > 5_000:
        pct *= 1.1

    if is_must_add:
        pct = max(pct, 0.15)

    # An empty starting slot inflates marginal value enormously (you are
    # comparing against zero). Real market price is far lower.
    if filling_empty_slot:
        pct = min(pct, 0.12)

    # Kickers and defenses are streamed, not bought.
    cap = POSITION_BID_CAP.get(position, MAX_BID_PCT)
    pct = max(0.0, min(cap, pct))

    bid = max(1, int(round(budget_left * pct)))
    return bid, round(pct * 100, 1)


def _evaluate(state: LeagueState, candidates: list[tuple[str, float]],
              roster_pts: dict[str, float], positions: dict[str, str],
              week_roster: dict[str, float], week_pts: dict[str, float],
              trending: dict[str, int], budget_left: int, weeks_left: int,
              vors: dict[str, float] | None = None,
              levels_rank: dict[str, int] | None = None,
              me_priority: int = 0
              ) -> dict[str, WaiverTarget]:
    """Score every candidate against one specific roster state."""
    rules = state.rules
    levels_rank = levels_rank or {}
    base_lineup = optimize(rules, roster_pts, positions)
    base_ros = base_lineup.total
    base_week = lineup_value(rules, week_roster, positions)
    roster_full = len(roster_pts) >= rules.roster_size

    # Pass 1: marginal value only. Cheap, and it tells us who is worth the
    # much more expensive drop search.
    scored: list[tuple[str, float, float]] = []
    for pid, ros_pts in candidates:
        p = state.players.get(pid)
        if not p:
            continue
        after = dict(roster_pts); after[pid] = ros_pts
        after_pos = dict(positions); after_pos[pid] = p.position
        marginal = round(lineup_value(rules, after, after_pos) - base_ros, 2)
        if marginal > MIN_MARGINAL:
            scored.append((pid, ros_pts, marginal))
    scored.sort(key=lambda t: -t[2])
    scored = scored[:DROP_SEARCH_WIDTH]

    starting_now = set(optimize(rules, week_roster, positions).starter_ids())
    drops = _rank_drops(rules, roster_pts, positions, state.players,
                        starting_now, 12, include_starters=False)

    out: dict[str, WaiverTarget] = {}
    for pid, ros_pts, marginal in scored:
        p = state.players.get(pid)
        after = dict(roster_pts); after[pid] = ros_pts
        after_pos = dict(positions); after_pos[pid] = p.position

        aw = dict(week_roster); aw[pid] = week_pts.get(pid, 0.0)
        marginal_week = round(lineup_value(rules, aw, after_pos) - base_week, 2)

        # If the roster is full, pick the drop that preserves the most value
        # *after* the add -- the new player may cover the vacated role.
        drop = None
        drop_cost = 0.0
        if roster_full and drops:
            # Never trade down in asset quality. Greedy sequencing will happily
            # cut a top-tier TE to stream a defense once a replacement is
            # claimed -- the lineup math says it's free, but you've destroyed a
            # real asset. Only cut players worth no more than the incoming one.
            v_in = (vors or {}).get(pid, 0.0)
            eligible = [d for d in drops
                        if d.player_id != pid
                        and (vors or {}).get(d.player_id, 0.0) <= max(v_in, 0.0)]
            if not eligible:
                eligible = sorted(
                    (d for d in drops if d.player_id != pid),
                    key=lambda d: (vors or {}).get(d.player_id, 0.0),
                )[:1]
            best = None
            for d in eligible:
                trial = dict(after); trial.pop(d.player_id, None)
                cost = round((base_ros + marginal) - lineup_value(rules, trial, after_pos), 2)
                if best is None or cost < best[1]:
                    best = (d, cost)
            if best:
                drop, drop_cost = best

        net = round(marginal - drop_cost, 2)
        if net <= 0:
            continue

        tr = trending.get(pid, 0)
        empty_slot = any(s.player_id is None for s in base_lineup.slots
                         if p.position in SLOT_ELIGIBILITY.get(s.slot, {s.slot}))
        bid, pct = _faab_bid(rules, net, budget_left, weeks_left, tr,
                             marginal / weeks_left > 2.0,
                             position=p.position, filling_empty_slot=empty_slot)

        bits = []
        if marginal_week > 0.5:
            bits.append(f"upgrades your week-{state.current_week} lineup by {marginal_week:.1f} pts")
        bits.append(f"+{marginal:.1f} pts rest-of-season to your starting lineup")
        if tr > 5000:
            bits.append(f"{tr:,} adds league-wide in 24h — expect competition")
        if p.injury_note:
            bits.append(f"listed {p.injury_note}")
        bye = state.projections.bye_for(pid)
        if bye and bye >= state.current_week:
            bits.append(f"bye week {bye}")

        # Where he actually slots in, and who he pushes out of the lineup.
        after_lineup = optimize(rules, after, after_pos)
        fills = next((s.slot for s in after_lineup.slots if s.player_id == pid), None)
        pushed = set(base_lineup.starter_ids()) - set(after_lineup.starter_ids())
        pushed_name = ", ".join(
            state.players.get(x).name for x in pushed if state.players.get(x)
        )

        why: list[dict] = []
        why.append({"h": "What he's worth in your league", "t":
            f"{ros_pts:.1f} projected points from here to the playoffs, scored "
            f"with your league's own settings ({rules.ppr_label}"
            + (f", TE premium +{rules.te_premium}/rec" if rules.te_premium else "")
            + f"). Replacement level at {p.position} in a {rules.num_teams}-team "
              f"league like yours is roughly the "
              f"{levels_rank.get(p.position, '—')}th {p.position}, so he is "
              f"genuinely above what's freely available."})

        if fills:
            why.append({"h": "Where he fits", "t":
                f"He starts at {fills}"
                + (f", pushing {pushed_name} out of your lineup" if pushed_name
                   else ", filling a slot nothing on your roster covers")
                + f" — worth {marginal:.1f} extra points spread over the "
                  f"{weeks_left} weeks before playoffs, or about "
                  f"{marginal/max(1,weeks_left):.1f} a week."})
        else:
            why.append({"h": "Where he fits", "t":
                "He does not crack your starting lineup outright, but he raises "
                "your floor across byes and injuries."})

        why.append({"h": "Why this is measured as a gain", "t":
            f"Ranked by what he adds to your STARTING lineup (+{marginal:.1f}), "
            f"not by his raw projection. A player who never starts is worth "
            f"nothing to you no matter how good his ranking looks — that is why "
            f"bigger names below him on the wire are not recommended."})

        if drop:
            why.append({"h": f"Why drop {drop.name}", "t":
                f"Cutting him costs you {drop.cost:.1f} points of lineup value"
                + (" — nothing, because someone behind him absorbs the role"
                   if drop.cost < 0.5 else "")
                + f". He is the cheapest legal cut that isn't in your week-"
                  f"{state.current_week} lineup, and he is not worth more than "
                  f"the player coming in. Net gain after the swap: {net:.1f}."})

        if rules.uses_faab:
            why.append({"h": f"Why ${bid}", "t":
                f"{net:.1f} points over {weeks_left} remaining weeks is "
                f"{net/max(1,weeks_left):.1f} per week. That scales to {pct:.0f}% "
                f"of your ${budget_left} remaining budget"
                + (f", bumped up because {tr:,} managers added him in the last "
                   f"24 hours and you will be outbid at a token price."
                   if tr > 5000 else ".")
                + ("" if p.position not in POSITION_BID_CAP else
                   f" Capped low because {p.position} is a streaming position — "
                   f"next week's option is nearly as good.")})
        else:
            why.append({"h": "What the claim costs you", "t":
                f"This league uses {rules.waiver_type} waiver priority, not FAAB, "
                f"so there is nothing to bid. Making the claim spends your "
                f"#{me_priority} priority and sends you to the back of the order — "
                f"worth it here, but it is the real price."})

        risks = []
        if p.injury_note:
            risks.append(f"he is listed {p.injury_note}")
        bye_w = state.projections.bye_for(pid)
        if bye_w and bye_w >= state.current_week:
            risks.append(f"his bye is week {bye_w}")
        if tr > 30_000:
            risks.append(f"{tr:,} adds league-wide in 24h means real competition")
        if marginal_week < 0.5:
            risks.append("he does not help your lineup this week — this is a "
                         "rest-of-season play")
        if risks:
            why.append({"h": "What could go wrong", "t":
                risks[0][0].upper() + risks[0][1:]
                + ("; " + "; ".join(risks[1:]) if len(risks) > 1 else "") + "."})

        out[pid] = WaiverTarget(
            player_id=pid, name=p.name, position=p.position, team=p.team,
            projection_ros=round(ros_pts, 2), marginal_ros=marginal,
            marginal_week=marginal_week,
            drop_id=drop.player_id if drop else None,
            drop_name=drop.name if drop else "",
            drop_cost=drop_cost, net_gain=net,
            faab_bid=bid, faab_pct=pct, trending_adds=tr,
            rationale="; ".join(bits), reasoning=why,
        )
    return out


def recommend_waivers(state: LeagueState, ros: dict[str, float],
                      week_pts: dict[str, float],
                      levels: ReplacementLevels,
                      *, limit: int = 5, pool: int = 120) -> list[WaiverTarget]:
    """Independent claims to make, each carrying its own fallbacks.

    Moves are chosen greedily: take the best claim, apply it to the roster,
    then re-score. A candidate whose value survives that is a genuinely
    separate move; one whose value collapses was after the same job and gets
    attached to the winner as an alternative.
    """
    me = state.me
    if not me:
        return []
    rules = state.rules

    roster_pts = dict(state.roster_projection(me, ros))
    positions = dict(state.positions_map(roster_pts))
    week_roster = {pid: week_pts.get(pid, 0.0) for pid in me.active_players()}

    trending = {str(t["player_id"]): int(t["count"])
                for t in state.s.trending("add", hours=24, limit=200)}
    budget_left = max(0, rules.waiver_budget - me.waiver_budget_used)
    weeks_left = max(1, state.weeks_remaining)

    vors = vor(ros, state.players, levels)
    remaining = sorted(state.free_agents(ros).items(), key=lambda kv: -kv[1])[:pool]

    moves: list[WaiverTarget] = []
    for _ in range(limit):
        scored = _evaluate(state, remaining, roster_pts, positions,
                           week_roster, week_pts, trending, budget_left,
                           weeks_left, vors, levels.rank_used, me.waiver_position)
        if not scored:
            break
        best = max(scored.values(), key=lambda w: w.net_gain)

        # Commit the winning claim, then see what survives it.
        roster_pts[best.player_id] = best.projection_ros
        positions[best.player_id] = best.position
        week_roster[best.player_id] = week_pts.get(best.player_id, 0.0)
        if best.drop_id:
            roster_pts.pop(best.drop_id, None)
            week_roster.pop(best.drop_id, None)
        remaining = [(p, v) for p, v in remaining if p != best.player_id]

        after = _evaluate(state, remaining, roster_pts, positions,
                          week_roster, week_pts, trending, budget_left,
                          weeks_left, vors, levels.rank_used, me.waiver_position)

        alts, survivors = [], []
        for pid, before in scored.items():
            if pid == best.player_id:
                continue
            still = after.get(pid)
            kept = (still.net_gain / before.net_gain) if still and before.net_gain > 0 else 0.0
            if kept < ALTERNATIVE_RETENTION:
                alts.append(before)          # was chasing the same job
            else:
                survivors.append(pid)
        alts.sort(key=lambda w: -w.net_gain)
        best.alternatives = alts[:4]

        consumed = {a.player_id for a in alts}
        remaining = [(p, v) for p, v in remaining if p not in consumed]
        if not remaining:
            moves.append(best)
            break
        moves.append(best)

    return moves
