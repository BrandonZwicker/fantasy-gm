"""Offline harness: a realistic 12-team league built from real player data.

Lets us exercise the whole pipeline without touching anyone's private league.
"""
from __future__ import annotations

from gm.players import PlayerIndex
from gm.projections import ProjectionBook
from gm.scoring import LeagueRules
from gm.sleeper import Sleeper

SEASON = "2025"
TEAMS = 12
ROSTER = (["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"] + ["BN"] * 6 + ["IR"])
SCORING = {
    "pass_yd": 0.04, "pass_td": 4, "pass_int": -2, "pass_2pt": 2,
    "rush_yd": 0.1, "rush_td": 6, "rush_2pt": 2,
    "rec": 1.0, "rec_yd": 0.1, "rec_td": 6, "rec_2pt": 2,
    "fum_lost": -2, "fgm": 3, "xpm": 1,
    "def_st_td": 6, "pts_allow_0": 10, "sack": 1, "int": 2, "fum_rec": 2,
}
SETTINGS = {
    "waiver_type": 2, "waiver_budget": 100, "waiver_day_of_week": 2,
    "waiver_clear_days": 2, "trade_deadline": 11, "playoff_week_start": 15,
    "playoff_teams": 6, "type": 0, "num_teams": TEAMS,
}


def league_dict(league_id="SYNTH1") -> dict:
    return {
        "league_id": league_id, "name": "Synthetic Test League",
        "season": SEASON, "total_rosters": TEAMS,
        "roster_positions": list(ROSTER), "scoring_settings": dict(SCORING),
        "settings": dict(SETTINGS), "status": "in_season",
    }


def _snake_draft(pool: list[str], teams: int, rounds: int) -> list[list[str]]:
    picks = [[] for _ in range(teams)]
    i = 0
    for rd in range(rounds):
        order = range(teams) if rd % 2 == 0 else reversed(range(teams))
        for t in order:
            if i < len(pool):
                picks[t].append(pool[i])
                i += 1
    return picks


def build(sleeper: Sleeper, my_slot: int = 3):
    """Return (league, rosters, users) drafted from real projection rankings."""
    rules = LeagueRules.from_league(league_dict())
    pi = PlayerIndex(sleeper)
    pb = ProjectionBook(sleeper, rules, pi, season=SEASON)
    totals = pb.season_totals()

    # Draft realistically: positional caps so nobody ends up with nine QBs.
    caps = {"QB": 2, "RB": 5, "WR": 5, "TE": 2, "K": 1, "DEF": 1}
    ranked = sorted(totals.items(), key=lambda kv: -kv[1])
    pool: list[str] = []
    counts: dict[str, int] = {}
    for pid, _ in ranked:
        p = pi.get(pid)
        if not p or p.position not in caps:
            continue
        if counts.get(p.position, 0) >= caps[p.position] * TEAMS:
            continue
        counts[p.position] = counts.get(p.position, 0) + 1
        pool.append(pid)

    # Draft starters-first so every team ends up with a legal lineup,
    # the way a real draft board does.
    priority = {"QB": 0, "RB": 1, "WR": 1, "TE": 2, "K": 8, "DEF": 8}
    pool.sort(key=lambda pid: (priority.get(pi.get(pid).position, 5)
                               if pi.get(pid) else 5, -totals.get(pid, 0)))
    # Pull one K and one DEF per team out first -- every real team fields them,
    # and leaving slots structurally empty distorts every downstream number.
    def _take(pos, n):
        got = [p for p in pool if pi.get(p) and pi.get(p).position == pos][:n]
        for g in got:
            pool.remove(g)
        return got

    kickers = _take("K", TEAMS)
    defenses = _take("DEF", TEAMS)

    priority = {"QB": 0, "RB": 1, "WR": 1, "TE": 2}
    pool.sort(key=lambda pid: (priority.get(pi.get(pid).position, 5)
                               if pi.get(pid) else 5, -totals.get(pid, 0)))
    rounds = len([r for r in ROSTER if r != "IR"]) - 2
    drafted = _snake_draft(pool, TEAMS, rounds)
    for i in range(TEAMS):
        if i < len(kickers):
            drafted[i].append(kickers[i])
        if i < len(defenses):
            drafted[i].append(defenses[i])

    rosters, users = [], []
    for idx, players in enumerate(drafted):
        rid = idx + 1
        uid = f"user_{rid}"
        # Fill starters naively (as a real, slightly careless manager would),
        # so the optimizer has something to correct.
        starters = []
        used = set()
        for slot in rules.starting_slots:
            from gm.scoring import SLOT_ELIGIBILITY
            elig = SLOT_ELIGIBILITY.get(slot, {slot})
            pick = next((p for p in players
                         if p not in used and pi.get(p) and pi.get(p).position in elig), None)
            if pick:
                used.add(pick)
                starters.append(pick)
            else:
                starters.append("0")
        rosters.append({
            "roster_id": rid, "owner_id": uid, "league_id": "SYNTH1",
            "players": players, "starters": starters, "reserve": [], "taxi": [],
            "settings": {"wins": 3, "losses": 2, "ties": 0, "fpts": 500,
                          "fpts_decimal": 0, "fpts_against": 480,
                          "fpts_against_decimal": 0,
                          "waiver_budget_used": 10 + rid, "waiver_position": rid},
        })
        users.append({"user_id": uid, "display_name": f"manager{rid}",
                      "metadata": {"team_name": f"Team {rid}"}})

    return league_dict(), rosters, users, f"user_{my_slot}"


def patch(sleeper_cls, league, rosters, users):
    """Monkeypatch the client so LeagueState reads synthetic league data
    while still hitting the real players/projections endpoints."""
    sleeper_cls.league = lambda self, lid, force=False: league
    sleeper_cls.rosters = lambda self, lid, force=False: rosters
    sleeper_cls.league_users = lambda self, lid, force=False: users
    sleeper_cls.transactions = lambda self, lid, wk, force=False: []
    sleeper_cls.state = lambda self, force=False: {
        "week": 4, "season": SEASON, "season_type": "regular",
        "display_week": 4, "league_season": SEASON,
    }
