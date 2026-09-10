"""Orchestrator: turns league state into a ranked queue of concrete actions."""
from __future__ import annotations

import datetime as dt
from dataclasses import asdict, dataclass, field

from . import db
from .league import LeagueState
from .lineup import Lineup, optimize
from .scoring import SLOT_ELIGIBILITY
from .monitor import Change, detect
from .sleeper import Sleeper
from .trades import TradeIdea, find_trades, trade_chips
from .value import ReplacementLevels, replacement_levels, vor
from .waivers import DropCandidate, WaiverTarget, drop_candidates, recommend_waivers

# Sleeper stores waiver day as 0=Tuesday ... 6=Monday.
WAIVER_DAYS = ["Tuesday", "Wednesday", "Thursday", "Friday",
               "Saturday", "Sunday", "Monday"]
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
RISK_PROFILES = {
    # Thresholds measured, not guessed: against 2025 results, weekly projections
    # carry an SD near 6.8 points for skill players, so the gap between two
    # players has an SD near 9.6. A 1-point edge is right 54% of the time, 2.5
    # points 60%, 5 points 70%. Waiver and trade floors sit higher because those
    # moves also cost an irreversible drop and finite FAAB or priority.
    "cautious":   {"label": "Cautious",   "start_sit": 5.0,
                   "waiver_per_week": 3.0, "trade_gain": 15.0},
    "balanced":   {"label": "Balanced",   "start_sit": 2.5,
                   "waiver_per_week": 1.5, "trade_gain": 8.0},
    "aggressive": {"label": "Aggressive", "start_sit": 1.0,
                   "waiver_per_week": 0.5, "trade_gain": 3.0},
}
DEFAULT_RISK = "balanced"

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
    risk: str = DEFAULT_RISK
    held_back: int = 0
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
                 risk: str = DEFAULT_RISK, con=None) -> Report:
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
    floor = RISK_PROFILES.get(risk, RISK_PROFILES[DEFAULT_RISK])
    next_waiver_txt = _next_waiver_run(rules)
    lineup = None
    lineup_gain = 0.0
    trade_note = ""
    current_starters: list[str] = []
    waivers: list[WaiverTarget] = []
    drops: list[DropCandidate] = []
    trades: list[TradeIdea] = []
    faab_left = 0

    if me:
        current_starters = list(me.starters)
        roster_week = {pid: week_pts.get(pid, 0.0) for pid in me.active_players()}
        positions = state.positions_map(roster_week)
        lineup = optimize(rules, roster_week, positions)

        current_total = round(sum(week_pts.get(p, 0.0) for p in current_starters), 2)
        lineup_gain = round(lineup.total - current_total, 2)

        # ---- start/sit ----
        # Report who actually enters and leaves the lineup. A player moving
        # between slots is not a benching, and reporting it as one is wrong.
        optimal_ids = set(lineup.starter_ids())
        current_ids = {p for p in current_starters if p and p != "0"}
        slot_of = {s.player_id: s.slot for s in lineup.slots if s.player_id}
        weeks_left = max(1, state.weeks_remaining)

        entering = optimal_ids - current_ids
        leaving = sorted(current_ids - optimal_ids,
                         key=lambda p: week_pts.get(p, 0.0))
        handled: set[str] = set()

        # Pair each incoming player with the player he actually displaces, by
        # slot. Zipping the two lists by index pairs unrelated players -- it
        # will cheerfully tell you to start a QB "over" a tight end.
        pairs: list[tuple[str, str | None, str]] = []
        for i, slot in enumerate(lineup.slots):
            new_pid = slot.player_id
            if not new_pid or new_pid not in entering:
                continue
            here = current_starters[i] if i < len(current_starters) else None
            if here in ("0", ""):
                here = None
            out_pid = None
            if here and here in set(leaving) and here not in handled:
                out_pid = here            # he literally held this slot
            else:
                elig = SLOT_ELIGIBILITY.get(slot.slot, {slot.slot})
                options = [x for x in leaving if x not in handled
                           and (state.players.get(x).position
                                if state.players.get(x) else None) in elig]
                if options:
                    out_pid = min(options, key=lambda x: week_pts.get(x, 0.0))
            if out_pid:
                handled.add(out_pid)
            pairs.append((new_pid, out_pid, slot.slot))

        for new_pid, out_pid, slot_name in pairs:
            np_ = state.players.get(new_pid)
            op = state.players.get(out_pid) if out_pid else None
            in_pts = week_pts.get(new_pid, 0.0)
            out_pts = week_pts.get(out_pid, 0.0) if out_pid else 0.0
            gain = round(in_pts - out_pts, 2)
            over = f" over {op.name}" if op else " (empty slot)"

            driver = ""
            if op and not state.projections.has_game(out_pid, week):
                driver = f"{op.name} is on a bye this week and will score zero"
                tail = f" — {op.name} is on BYE"
            elif op and op.injury_status in {"Out", "IR", "Doubtful"}:
                driver = f"{op.name} is listed {op.injury_status}"
                tail = f" — {op.name} is {op.injury_status}"
            else:
                tail = ""

            why = [{"h": "The swap", "t":
                    f"{np_.name if np_ else new_pid} projects {in_pts:.1f} points "
                    f"in week {week}"
                    + (f" against {out_pts:.1f} for {op.name}" if op
                       else " and the slot is currently empty")
                    + f" — a swing of {gain:.1f} points, scored under your "
                      f"league's settings rather than generic rankings."}]
            if driver:
                why.append({"h": "Why now", "t": driver[0].upper() + driver[1:] + "."})
            why.append({"h": "Why this player and not another", "t":
                f"Your whole roster is assigned to slots at once rather than "
                f"picked one at a time, so flex spots get filled optimally. "
                f"This is the best legal arrangement of the players you have, "
                f"totalling {lineup.total:.1f} projected points."})
            why.append({"h": "The clock", "t":
                "Lineup changes are only worth anything before kickoff. Once "
                "the game starts this is unrecoverable, which is why it "
                "outranks waiver and trade moves that still have days of runway."})

            actions.append(Action(
                kind="start_sit", priority=1,
                headline=f"START {np_.name if np_ else new_pid} at "
                         f"{slot_name}{over}{tail}",
                detail=f"{in_pts:.1f} proj vs {out_pts:.1f} — "
                       f"+{gain:.1f} pts in week {week}",
                payload={"player_id": new_pid, "slot": slot_name,
                         "bench": out_pid, "gain": gain},
                impact=gain, per_week=gain,
                weight=gain * URGENCY["lineup"],
                horizon=f"Before week {week} kickoff",
                reasoning=why,
            ))

        # Starters with no viable replacement -- a warning, not a swap.
        for pid in optimal_ids | current_ids:
            if pid in handled:
                continue
            p = state.players.get(pid)
            if not p:
                continue
            on_bye = not state.projections.has_game(pid, week)
            hurt = p.injury_status in {"Out", "IR", "Doubtful"}
            if not (on_bye or hurt) or pid not in current_ids:
                continue
            label = f"on BYE in week {week}" if on_bye else f"{p.injury_status}"
            actions.append(Action(
                kind="alert", priority=1,
                headline=f"{p.name} is {label} and is in your lineup",
                detail="They will score zero. Nothing on your bench beats them "
                       "outright, so look at the waiver wire.",
                payload={"player_id": pid},
                impact=0.0, per_week=0.0, weight=7.0,
                horizon=f"Before week {week} kickoff",
                reasoning=[
                    {"h": "What happens if you do nothing", "t":
                     f"{p.name} takes a zero in a starting slot. In a "
                     f"{rules.num_teams}-team league that is usually the "
                     f"difference in a weekly matchup."},
                    {"h": "Why no swap is offered", "t":
                     "No player on your bench projects higher in a slot they "
                     "are eligible for, so there is no free fix — the answer "
                     "is on the waiver wire, not your roster."},
                ],
            ))

        # ---- waivers & drops ----
        faab_left = max(0, rules.waiver_budget - me.waiver_budget_used)
        waivers = recommend_waivers(state, ros, week_pts, levels, limit=10)
        drops = drop_candidates(state, ros, limit=8, week_pts=week_pts)
        for i, w in enumerate(waivers[:5]):
            if rules.uses_faab and w.faab_bid:
                bid = f" — bid ${w.faab_bid} ({w.faab_pct:.0f}% of your ${faab_left})"
            elif not rules.uses_faab:
                # Rolling/reverse waivers: the cost is spending your priority.
                bid = (f" — uses your #{me.waiver_position} waiver priority"
                       if me.waiver_position else "")
            else:
                bid = ""
            drop_txt = f", drop {w.drop_name}" if w.drop_id else ""
            per_week = w.net_gain / weeks_left
            actions.append(Action(
                kind="waiver",
                priority=2,
                headline=f"CLAIM {w.name} ({w.position}-{w.team}){bid}{drop_txt}",
                detail=w.rationale,
                payload={"player_id": w.player_id, "bid": w.faab_bid,
                         "drop_id": w.drop_id, "net_gain": w.net_gain,
                         "alternatives": [
                             {"label": f"{a.name} ({a.position}-{a.team})",
                              "bid": a.faab_bid, "net_gain": a.net_gain,
                              "drop_name": a.drop_name, "detail": a.rationale}
                             for a in w.alternatives
                         ]},
                impact=w.net_gain, per_week=round(per_week, 2),
                weight=per_week * URGENCY["waiver"],
                horizon=f"Waivers run {next_waiver_txt}",
                reasoning=w.reasoning,
            ))

        # ---- trades ----
        if do_trades:
            trades = find_trades(state, ros, levels, limit=6,
                                 min_my_gain=floor["trade_gain"])
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
                        + ("them" if len(names) > 1 else "him")
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
                    {"h": "The clock", "t":
                     f"The trade deadline is week {rules.trade_deadline_week}, "
                     f"{max(0, rules.trade_deadline_week - week)} weeks out. "
                     f"There is runway here, which is why trades rank below "
                     f"lineup and waiver moves that expire sooner."},
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

    # ---- alerts from change detection ----
    INFO_WEIGHT = {("critical", True): 5.0, ("critical", False): 2.2,
                   ("high", True): 1.9, ("high", False): 0.9}
    for c in changes:
        if c.severity in {"critical", "high"}:
            actions.append(Action(
                kind="alert", priority=2,
                headline=c.headline, detail=c.detail,
                payload={"category": c.category, "affects_me": c.affects_me},
                impact=0.0, per_week=0.0,
                weight=INFO_WEIGHT.get((c.severity, bool(c.affects_me)), 0.8),
                horizon="Reacting early is the edge",
                reasoning=[{"h": "Why you are seeing this", "t":
                    (f"This touches your own roster. " if c.affects_me else
                     "This is league news that may open an opportunity. ")
                    + (c.detail or c.headline)
                    + " Detected by comparing the league against the last check."}],
            ))

    # Drop moves whose edge is too small to be worth acting on. Warnings stay:
    # a bye week is a certainty, not a projected edge.
    def _below_floor(a: Action) -> bool:
        if a.kind == "start_sit":
            return a.impact < floor["start_sit"]
        if a.kind == "waiver":
            return a.per_week < floor["waiver_per_week"]
        if a.kind == "trade":
            return a.impact < floor["trade_gain"]
        return False

    held_back = sum(1 for a in actions if _below_floor(a))
    actions = [a for a in actions if not _below_floor(a)]

    # Rank everything on one scale: points at stake, weighted by how soon the
    # chance to act disappears. This is what orders the list.
    actions.sort(key=lambda a: -a.weight)
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
        risk=risk, held_back=held_back,
        faab_left=faab_left, next_waiver=next_waiver_txt,
        deadlines=deadlines,
        waiver_type=rules.waiver_type, uses_faab=rules.uses_faab,
        waiver_position=me.waiver_position if me else 0,
    )
    if owned_con:
        con.close()
    return report
