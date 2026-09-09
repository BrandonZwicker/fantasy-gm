"""Projections re-scored under a specific league's rules."""
from __future__ import annotations

from dataclasses import dataclass

from .players import PlayerIndex
from .scoring import LeagueRules
from .sleeper import Sleeper

# NFL regular season length (weeks 1..18).
LAST_REG_WEEK = 18


@dataclass
class WeekProjection:
    player_id: str
    points: float          # scored under league rules
    team: str | None
    opponent: str | None
    week: int


class ProjectionBook:
    """Fetches and re-scores projections for one league."""

    def __init__(self, sleeper: Sleeper, rules: LeagueRules,
                 players: PlayerIndex, season: str | None = None):
        self.s = sleeper
        self.rules = rules
        self.players = players
        self.season = season or rules.season
        self._weeks: dict[int, dict[str, WeekProjection]] = {}
        self._season_totals: dict[str, float] | None = None
        self._bye: dict[str, int] | None = None

    # ---------- weekly ----------

    def week(self, week: int, force: bool = False) -> dict[str, WeekProjection]:
        if week in self._weeks and not force:
            return self._weeks[week]
        raw = self.s.projections(self.season, week, force=force)
        out: dict[str, WeekProjection] = {}
        for e in raw or []:
            pid = str(e.get("player_id") or "")
            if not pid:
                continue
            out[pid] = WeekProjection(
                player_id=pid,
                points=self.rules.score(e.get("stats")),
                team=e.get("team"),
                opponent=e.get("opponent"),
                week=week,
            )
        self._weeks[week] = out
        return out

    def points(self, pid: str, week: int, *, injury_adjusted: bool = True) -> float:
        wp = self.week(week).get(str(pid))
        base = wp.points if wp else 0.0
        if injury_adjusted:
            p = self.players.get(pid)
            if p:
                base *= p.availability
        return round(base, 2)

    def opponent(self, pid: str, week: int) -> str | None:
        wp = self.week(week).get(str(pid))
        return wp.opponent if wp else None

    def has_game(self, pid: str, week: int) -> bool:
        """False on a bye week or when the player isn't on a roster."""
        wp = self.week(week).get(str(pid))
        return bool(wp and wp.opponent)

    # ---------- season / rest-of-season ----------

    def season_totals(self, force: bool = False) -> dict[str, float]:
        """Full-season projected points under league scoring (one API call)."""
        if self._season_totals is not None and not force:
            return self._season_totals
        raw = self.s.projections(self.season, None, force=force)
        out: dict[str, float] = {}
        for e in raw or []:
            pid = str(e.get("player_id") or "")
            if pid:
                out[pid] = self.rules.score(e.get("stats"))
        self._season_totals = out
        return out

    def rest_of_season(self, from_week: int, through_week: int | None = None
                       ) -> dict[str, float]:
        """Sum of weekly projections from `from_week` onward.

        Weeks Sleeper hasn't published yet are extrapolated from each player's
        own weekly average rather than from the season-long endpoint, which is
        incomplete for some positions: it returns ``fgm: None`` for kickers,
        counting only extra points, which understates them by roughly two
        thirds. Season totals are the fallback only when no weekly data exists.
        """
        through = through_week or LAST_REG_WEEK
        totals: dict[str, float] = {}
        played: dict[str, int] = {}
        weeks_found = 0
        for w in range(from_week, through + 1):
            wk = self.week(w)
            if not wk:
                continue
            weeks_found += 1
            for pid, wp in wk.items():
                totals[pid] = totals.get(pid, 0.0) + wp.points
                # Only count weeks with a game so byes don't drag the average.
                if wp.opponent:
                    played[pid] = played.get(pid, 0) + 1

        weeks_missing = (through - from_week + 1) - weeks_found
        if weeks_missing > 0:
            season = self.season_totals()
            for pid in set(totals) | set(season):
                games = played.get(pid, 0)
                per_week = (totals[pid] / games if games
                            else season.get(pid, 0.0) / LAST_REG_WEEK)
                totals[pid] = totals.get(pid, 0.0) + per_week * weeks_missing
        return {k: round(v, 2) for k, v in totals.items()}

    # ---------- byes ----------

    def bye_weeks(self, scan_weeks: int = LAST_REG_WEEK) -> dict[str, int]:
        """Derive each team's bye by finding the week it has no scheduled game."""
        if self._bye is not None:
            return self._bye
        seen: dict[int, set[str]] = {}
        all_teams: set[str] = set()
        for w in range(1, scan_weeks + 1):
            wk = self.week(w)
            if not wk:
                continue
            teams = {wp.team for wp in wk.values() if wp.team and wp.opponent}
            seen[w] = teams
            all_teams |= teams
        bye: dict[str, int] = {}
        for w, teams in seen.items():
            # A bye only counts once the slate is clearly populated.
            if len(teams) < 20:
                continue
            for t in all_teams - teams:
                bye.setdefault(t, w)
        self._bye = bye
        return bye

    def bye_for(self, pid: str) -> int | None:
        p = self.players.get(pid)
        return self.bye_weeks().get(p.team) if p and p.team else None
