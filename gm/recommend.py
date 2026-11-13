"""Orchestrator: turns league state into a ranked queue of concrete actions."""
from __future__ import annotations

import datetime as dt
from dataclasses import asdict, dataclass, field

from . import db
from .league import LeagueState
from .lineup import Lineup, LineupSlot, optimize
from .players import pronouns
from .scoring import SLOT_ELIGIBILITY
from .monitor import Change, detect
from .roster import RosterFix, apply_moves, clone_team, plan_roster_fix
from .sleeper import Sleeper
from .trades import TradeIdea, find_trades, trade_chips
from .value import ReplacementLevels, replacement_levels, vor
from .waivers import DropCandidate, WaiverTarget, drop_candidates, recommend_waivers

# Sleeper counts the waiver day from Monday: 2 processes early Wednesday,
# which is what a league's transaction log shows.
WAIVER_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
               "Saturday", "Sunday"]
_WEEKDAY_INDEX = {"Monday": 0, "Tuesday": 1, "Wednesday": 2, "Thursday": 3,
                  "Friday": 4, "Saturday": 5, "Sunday": 6}


# How hard each kind of move is pressed by the clock. A lineup change is
# worthless once kickoff passes; a trade has weeks of runway.
URGENCY = {
    "lineup": 3.2,   # locks at kickoff — this week's points, gone if missed
    "waiver": 1.6,   # locks at the next waiver run
    "trade": 0.9,    # weeks of runway until the deadline
    "info": 0.35,    # context, not a move
}

# How big an edge has to be before a move is worth making. Weekly projections
# carry several points of error, so a move gaining 0.8 projected points sits
# inside the noise -- as likely to cost you as to gain. Warnings (a bye, an
# injured starter) are never filtered: those are certainties, not edges.
# One fixed setting rather than a dial. Grounded in measured error: weekly
# projections carry an SD near 6.8 points for skill players, so the gap between
# two players has an SD near 9.6. A 1-point edge is right only 54% of the time;
# 2.5 points gets to 60%. Waiver and trade floors sit higher because those moves
# also cost an irreversible drop and finite FAAB or priority.
THRESHOLDS = {"start_sit": 2.5, "waiver_per_week": 1.5, "trade_gain": 8.0}

TIERS = [
    (6.0, 1, "Do now"),
    (2.0, 2, "This week"),
    (0.6, 3, "Worth doing"),
    (0.0, 4, "Optional"),
]


def _tier(weight: float) -> tuple[int, str]:
    for threshold, pri, label in TIERS:
        if weight >= threshold:
            return pri, label
    return 4, "Optional"


@dataclass
class Action:
    kind: str            # start_sit | waiver | drop | trade | alert
    priority: int        # 1 = do it now, 4 = optional
    headline: str
    detail: str = ""
    payload: dict = field(default_factory=dict)
    # Ranking inputs, so the UI can show why something sits where it does.
    impact: float = 0.0      # points at stake
    per_week: float = 0.0    # points per remaining week
    weight: float = 0.0      # impact x urgency — the sort key
    horizon: str = ""        # the deadline that applies
    tier_label: str = ""
    rank: int = 0
    reasoning: list[dict] = field(default_factory=list)


@dataclass
class Report:
    generated_at: str
    league_name: str
    league_id: str
    week: int
    my_team: str
    record: str
    settings_summary: list[str]
    lineup: Lineup | None
    current_starters: list[str]
    lineup_gain: float
    actions: list[Action]
    waivers: list[WaiverTarget]
    drops: list[DropCandidate]
    trades: list[TradeIdea]
    changes: list[Change]
    faab_left: int
    next_waiver: str
    deadlines: list[str]
    trade_note: str = ""
    held_back: int = 0
    roster_fix: RosterFix | None = None
    waiver_type: str = "none"      # faab | rolling | reverse | none
    uses_faab: bool = False
    waiver_position: int = 0

    def to_dict(self) -> dict:
        d = asdict(self)
        d["lineup"] = asdict(self.lineup) if self.lineup else None
        return d


def _next_waiver_run(rules) -> str:
    """Human description of when waivers next process."""
    if rules.waiver_type == "none":
        return "No waivers — free agents are first-come, first-served"
    day_name = WAIVER_DAYS[rules.waiver_day_of_week % 7]
    target = _WEEKDAY_INDEX[day_name]
    now = dt.datetime.now()
    delta = (target - now.weekday()) % 7
    if delta == 0 and now.hour >= 3:
        delta = 7
    run = (now + dt.timedelta(days=delta)).replace(hour=3, minute=0, second=0, microsecond=0)
    hrs = (run - now).total_seconds() / 3600
    return f"{day_name} ~3am ({hrs:.0f}h away)"


def build_report(league_id: str, user_id: str | None = None, *,
                 force: bool = False, do_trades: bool = True,
                 con=None) -> Report:
    s = Sleeper()
    state = LeagueState(s, league_id, user_id=user_id, force=force)
    rules = state.rules
    week = state.current_week
    me = state.me

    owned_con = con is None
    con = con or db.connect()

    # Projections: this week for start/sit, rest-of-season for asset value.
    week_pts = {pid: state.projections.points(pid, week)
                for pid in state.projections.week(week)}
    ros = state.projections.rest_of_season(week, rules.playoff_week_start - 1)
    # Injury-discount the rest-of-season view as well.
    for pid in list(ros):
        p = state.players.get(pid)
        if p and p.ros_multiplier < 1.0:
            ros[pid] = round(ros[pid] * p.ros_multiplier, 2)

    levels = replacement_levels(rules, ros, state.players)
    _ = vor(ros, state.players, levels)

    changes = detect(state, con)
    # Anything touching your own roster leads the feed.
    changes.sort(key=lambda c: (not c.affects_me,
                                {"critical": 0, "high": 1, "medium": 2}.get(c.severity, 3)))

    actions: list[Action] = []
    floor = THRESHOLDS
    next_waiver_txt = _next_waiver_run(rules)
    lineup = None
    lineup_gain = 0.0
    trade_note = ""
    current_starters: list[str] = []
    waivers: list[WaiverTarget] = []
    drops: list[DropCandidate] = []
    trades: list[TradeIdea] = []
    faab_left = 0

    weeks_left = max(1, state.weeks_remaining)

    # The report is a plan, not a menu. Each stage is worked out against the
    # roster the earlier stages leave behind, so no step can contradict,
    # repeat or offer an alternative to another one. Mirrors docs/report.js.
    def _below_floor(a: Action) -> bool:
        if a.kind == "start_sit":
            return not a.payload.get("forced") and a.impact < floor["start_sit"]
        if a.kind == "waiver":
            return a.per_week < floor["waiver_per_week"]
        if a.kind == "trade":
            return a.impact < floor["trade_gain"]
        return False

    roster_fix = None
    added: set[str] = set()
    original = me
    if me:
        # The full ranking comes from the roster as it stands.
        drops = drop_candidates(state, ros, limit=8, week_pts=week_pts)

        starters_before = list(me.starters)
        # ---- step 1: make the roster legal ----
        roster_fix = plan_roster_fix(state, me, ros, week_pts)
        vacated_by = {p: "moved to IR" for p in roster_fix.to_ir}
        vacated_by.update({d.player_id: "dropped" for d in roster_fix.drops})
        me = apply_moves(clone_team(me), to_ir=roster_fix.to_ir,
                         activate=roster_fix.activate,
                         drop=[d.player_id for d in roster_fix.drops])
        state.teams[state.my_roster_id] = me
        actions.extend(_roster_actions(state, roster_fix, week_pts))

        # ---- step 2: waivers, against the legal roster ----
        # No kickoff schedule on this side, so a claim is never assumed to
        # make this week's lineup. It changes the roster trades are planned on.
        faab_left = max(0, rules.waiver_budget - me.waiver_budget_used)
        waivers = recommend_waivers(state, ros, week_pts, levels, limit=10)
        planned: list[WaiverTarget] = []
        for w in waivers[:5]:
            if rules.uses_faab and w.faab_bid:
                bid = f" — bid ${w.faab_bid} ({w.faab_pct:.0f}% of your ${faab_left})"
            elif not rules.uses_faab:
                bid = (f" — uses your #{me.waiver_position} waiver priority"
                       if me.waiver_position else "")
            else:
                bid = ""
            drop_txt = f", drop {w.drop_name}" if w.drop_id else ""
            per_week = w.net_gain / weeks_left
            a = Action(
                kind="waiver", priority=2,
                headline=f"CLAIM {w.name} ({w.position}-{w.team}){drop_txt}{bid}",
                detail=w.rationale,
                payload={"player_id": w.player_id, "bid": w.faab_bid,
                         "drop_id": w.drop_id, "net_gain": w.net_gain,
                         "alternatives": [
                             {"label": f"{x.name} ({x.position}-{x.team})",
                              "bid": x.faab_bid, "net_gain": x.net_gain,
                              "drop_name": x.drop_name, "detail": x.rationale}
                             for x in w.alternatives
                         ]},
                impact=w.net_gain, per_week=round(per_week, 2),
                weight=per_week * URGENCY["waiver"],
                horizon=f"Waivers run {next_waiver_txt}",
                reasoning=w.reasoning,
            )
            actions.append(a)
            if not _below_floor(a):
                planned.append(w)
                added.add(w.player_id)

        # ---- step 3: the lineup, one swap at a time ----
        current_starters = list(me.starters)
        on_roster = set(me.active_players())
        slots = rules.starting_slots
        positions = state.positions_map(list(on_roster))

        def arrange(chosen: set[str]):
            pts = {p: week_pts.get(p, 0.0) + 1e-3 for p in chosen}
            lu = optimize(rules, pts, positions)
            if len(lu.starter_ids()) != len(pts):
                return None
            return [s_.player_id for s_ in lu.slots]

        def value_of(filled):
            return sum(week_pts.get(p, 0.0) for p in filled if p)

        def is_dead(pid):
            p = state.players.get(pid)
            return (not state.projections.has_game(pid, week)) or bool(
                p and p.injury_status in {"Out", "IR", "Doubtful"})

        prev = [(current_starters[i] if i < len(current_starters)
                 and current_starters[i] in on_roster else None)
                for i in range(len(slots))]
        start_total = value_of(prev)
        accepted = []
        for _ in range(len(slots) + 1):
            chosen = {p for p in prev if p}
            base = value_of(prev)
            bench = [p for p in on_roster if p not in chosen]
            empty_at = next((i for i, p in enumerate(prev) if not p), -1)
            best = None
            for e in bench:
                e_pos = positions.get(e)
                for l in ([None] if empty_at >= 0 else []) + sorted(chosen):
                    idx = prev.index(l) if l else empty_at
                    if e_pos in SLOT_ELIGIBILITY.get(slots[idx], {slots[idx]}):
                        filled = list(prev); filled[idx] = e
                    else:
                        nxt = set(chosen); nxt.discard(l); nxt.add(e)
                        filled = arrange(nxt)
                    if not filled:
                        continue
                    g = round(value_of(filled) - base, 2)
                    forced = l is None or is_dead(l)
                    if g >= floor["start_sit"] or (forced and g > 0.05):
                        if not best or g > best[2]:
                            best = (e, l, g, forced, filled, idx)
            if not best:
                break
            e, l, g, forced, filled, idx = best
            held_by = None if l else (starters_before[idx] if idx < len(starters_before) else None)
            shifts = [(p, slots[prev.index(p)], slots[i]) for i, p in enumerate(filled)
                      if p and p != e and p in prev and slots[prev.index(p)] != slots[i]]
            accepted.append((e, l, g, forced, filled, shifts, held_by))
            prev = filled

        lineup = Lineup(
            slots=[LineupSlot(slot=slots[i], player_id=prev[i],
                              points=round(week_pts.get(prev[i], 0.0), 2) if prev[i] else 0.0)
                   for i in range(len(slots))],
            bench=sorted(((p, round(week_pts.get(p, 0.0), 2))
                          for p in on_roster if p not in set(prev)),
                         key=lambda kv: -kv[1]),
            total=round(value_of(prev), 2),
        )
        lineup_gain = round(lineup.total - start_total, 2)

        for e, l, g, forced, filled, shifts, held_by in accepted:
            np_ = state.players.get(e)
            op = state.players.get(l) if l else None
            in_pts = week_pts.get(e, 0.0)
            out_pts = week_pts.get(l, 0.0) if l else 0.0
            slot_name = slots[filled.index(e)]
            if op:
                over = f" over {op.name}"
            elif held_by in vacated_by:
                hb = state.players.get(held_by)
                over = (f" in place of {hb.name if hb else held_by} "
                        f"({vacated_by[held_by]} above)")
            else:
                over = " (empty slot)"
            tail = ""
            if op and not state.projections.has_game(l, week):
                tail = f" — {op.name} is on BYE"
            elif op and op.injury_status in {"Out", "IR", "Doubtful"}:
                tail = f" — {op.name} is {op.injury_status}"
            shift_txt = ", ".join(f"{(state.players.get(p).name if state.players.get(p) else p)} moves from {a_} to {b_}"
                                  for p, a_, b_ in shifts)
            actions.append(Action(
                kind="start_sit", priority=1,
                headline=f"START {np_.name if np_ else e} at {slot_name}{over}{tail}",
                detail=f"{in_pts:.1f} proj vs {out_pts:.1f} — +{g:.1f} pts in week {week}"
                       + (f". To make room, {shift_txt}." if shift_txt else ""),
                payload={"player_id": e, "slot": slot_name, "bench": l,
                         "gain": g, "forced": forced},
                impact=g, per_week=g, weight=g * URGENCY["lineup"],
                horizon=f"Before week {week} kickoff",
                reasoning=[{"h": "The swap", "t":
                    f"{np_.name if np_ else e} projects {in_pts:.1f} points in week {week}"
                    + (f" against {out_pts:.1f} for {op.name}" if op else
                       " and the slot is currently empty")
                    + f", a swing of {g:.1f}. Each swap is made against the lineup "
                      f"the previous one left, so they can be done in order."}],
            ))

        # Starters with no viable replacement -- a warning, not a swap.
        for pid in [p for p in prev if p]:
            if not is_dead(pid):
                continue
            p = state.players.get(pid)
            if not p:
                continue
            label = (f"on BYE in week {week}" if not state.projections.has_game(pid, week)
                     else f"{p.injury_status}")
            actions.append(Action(
                kind="alert", priority=1,
                headline=f"{p.name} is {label} and is in your lineup",
                detail="They will score zero. Nothing on your bench can fill the "
                       "slot, and no free agent cleared the bar.",
                payload={"player_id": pid}, impact=0.0, per_week=0.0, weight=7.0,
                horizon=f"Before week {week} kickoff",
            ))

        # Claims change the roster that trades are planned against.
        for w in planned:
            apply_moves(me, add=[w.player_id], drop=[w.drop_id] if w.drop_id else [])

        # ---- trades ----
        if do_trades:
            trades = find_trades(state, ros, levels, limit=6,
                                 min_my_gain=floor["trade_gain"], keep=added)
            if not trades:
                # Say why rather than showing an empty panel. Naming the
                # chip is the actionable part: it's who to shop.
                chips = trade_chips(state, ros, levels, limit=2)
                names = [state.players.get(c).name for c, _ in chips
                         if state.players.get(c)]
                trade_note = (
                    "No trade currently improves both teams — rosters across "
                    "the league are still balanced, which is normal early. "
                )
                if names:
                    trade_note += (
                        f"Your most tradeable surplus is {' and '.join(names)}: "
                        "real value your lineup can't start. Shop "
                        + ("them" if len(names) > 1
                           else pronouns(state.players.get(chips[0][0]).position
                                         if state.players.get(chips[0][0]) else None)["obj"])
                        + " to a manager thin at that position and re-check "
                        "after the first injuries land."
                    )
            accept_factor = {"likely": 1.0, "possible": 0.7, "long shot": 0.4}
            for i, tr in enumerate(trades[:4]):
                per_week = tr.my_gain / weeks_left
                af = accept_factor.get(tr.acceptance, 0.5)
                why = [
                    {"h": "What you gain", "t":
                     f"Your starting lineup improves by {tr.my_gain:.1f} points "
                     f"rest-of-season — about {per_week:.1f} per week over the "
                     f"{weeks_left} weeks before playoffs."},
                    {"h": "Why they would say yes", "t":
                     f"Their lineup improves by {tr.their_gain:.1f} too. Trades "
                     f"happen when rosters are positionally imbalanced: your "
                     f"surplus is their hole. {tr.rationale}"},
                    {"h": "How likely it is to be accepted", "t":
                     f"You send {tr.value_ratio:.2f}x the market value you "
                     f"receive, which reads as {tr.acceptance} to be accepted. "
                     + ("Offers that would look insulting are filtered out "
                        "entirely rather than shown to you."
                        if tr.value_ratio >= 0.55 else "")},
                ]
                actions.append(Action(
                    kind="trade",
                    priority=3,
                    headline=f"OFFER {tr.partner_name}: {tr.summary}",
                    detail=tr.rationale,
                    payload={"partner": tr.partner_roster_id,
                             "send": tr.send, "receive": tr.receive,
                             "my_gain": tr.my_gain, "their_gain": tr.their_gain,
                             "alternatives": [
                                 {"label": f"{a.partner_name}: {a.summary}",
                                  "net_gain": a.my_gain,
                                  "detail": f"{a.acceptance} to be accepted · "
                                            f"them +{a.their_gain:.1f}"}
                                 for a in tr.alternatives
                             ]},
                    impact=tr.my_gain, per_week=round(per_week, 2),
                    weight=per_week * URGENCY["trade"] * af,
                    horizon=f"Trade deadline week {rules.trade_deadline_week}",
                    reasoning=why,
                ))

    # League news stays in `changes`. It is context, not a step.
    held_back = sum(1 for a in actions if _below_floor(a))
    actions = [a for a in actions if not _below_floor(a)]
    if original is not None:
        state.teams[state.my_roster_id] = original

    # Numbered in the order you do them: roster fixes, lineup, pickups,
    # warnings, then offers. Bigger move first within a stage.
    stage = {"roster": 0, "start_sit": 1, "waiver": 2, "alert": 3, "trade": 4}
    actions.sort(key=lambda a: (stage.get(a.kind, 5), -a.weight))
    for i, a in enumerate(actions, 1):
        a.rank = i
        a.priority, a.tier_label = _tier(a.weight)


    deadlines = []
    if week < rules.trade_deadline_week:
        deadlines.append(
            f"Trade deadline: week {rules.trade_deadline_week} "
            f"({rules.trade_deadline_week - week} weeks away)"
        )
    else:
        deadlines.append("Trade deadline has PASSED — waivers only from here")
    deadlines.append(
        f"Playoffs begin week {rules.playoff_week_start} "
        f"({rules.playoff_teams} of {rules.num_teams} teams qualify)"
    )

    report = Report(
        generated_at=dt.datetime.now().isoformat(timespec="seconds"),
        league_name=rules.name, league_id=league_id, week=week,
        my_team=me.label if me else "(no team linked)",
        record=me.record if me else "-",
        settings_summary=rules.describe(),
        lineup=lineup, current_starters=current_starters,
        lineup_gain=lineup_gain, actions=actions, waivers=waivers,
        drops=drops, trades=trades, changes=changes, trade_note=trade_note,
        held_back=held_back, roster_fix=roster_fix,
        faab_left=faab_left, next_waiver=next_waiver_txt,
        deadlines=deadlines,
        waiver_type=rules.waiver_type, uses_faab=rules.uses_faab,
        waiver_position=me.waiver_position if me else 0,
    )
    if owned_con:
        con.close()
    return report


def _roster_actions(state, fix: RosterFix, week_pts: dict[str, float]) -> list[Action]:
    """The steps that make the roster legal, written as actions."""
    out: list[Action] = []
    def name(pid):
        p = state.players.get(pid)
        return p.name if p else pid
    over_txt = (f"You have {fix.active_count} players on a {fix.limit}-man roster, "
                f"{fix.over_by} over the limit. Sleeper will not process an add, "
                f"claim or trade until that is fixed." if fix.over_by > 0 else "")
    for pid in fix.activate:
        out.append(Action(
            kind="roster", priority=1, headline=f"ACTIVATE {name(pid)} from IR",
            detail="No longer listed as injured, so can't stay on IR. Sleeper "
                   "freezes the roster until this is done.",
            payload={"player_id": pid, "move": "activate"}, weight=9.0,
            horizon="Now, before anything else"))
    for pid in fix.to_ir:
        p = state.players.get(pid)
        needed = fix.over_by > 0 or bool(fix.activate)
        out.append(Action(
            kind="roster", priority=1 if needed else 3,
            headline=f"MOVE {name(pid)} to IR",
            detail=f"Listed {(p.injury_status if p else '') or 'injured'} and you have "
                   f"an open IR slot. Frees a bench spot for nothing.",
            payload={"player_id": pid, "move": "ir"},
            weight=8.0 if needed else 1.2,
            horizon="Now, before anything else",
            reasoning=[{"h": "Why", "t": over_txt or "A free bench spot costs nothing."}]))
    for d in fix.drops:
        out.append(Action(
            kind="roster", priority=1, headline=f"DROP {d.name}",
            detail=f"Costs {d.cost:.1f} pts rest of season, the cheapest cut on your roster."
                   + (f" {d.next_name} is next at {d.next_cost:.1f}." if d.next_name else ""),
            payload={"player_id": d.player_id, "move": "drop", "cost": d.cost},
            weight=7.5, horizon="Now, before anything else",  # after IR moves
            reasoning=[{"h": "Why", "t": over_txt}]))
    return out
