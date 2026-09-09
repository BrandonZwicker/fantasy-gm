"""Assembled view of one league: teams, rosters, ownership, free agents."""
from __future__ import annotations

from dataclasses import dataclass, field

from .players import PlayerIndex
from .projections import ProjectionBook
from .scoring import LeagueRules, positions_in_play
from .sleeper import Sleeper


@dataclass
class Team:
    roster_id: int
    owner_id: str | None
    display_name: str
    team_name: str
    players: list[str] = field(default_factory=list)
    starters: list[str] = field(default_factory=list)
    reserve: list[str] = field(default_factory=list)
    taxi: list[str] = field(default_factory=list)
    wins: int = 0
    losses: int = 0
    ties: int = 0
    points_for: float = 0.0
    points_against: float = 0.0
    waiver_budget_used: int = 0
    waiver_position: int = 0

    @property
    def label(self) -> str:
        return self.team_name or self.display_name or f"Roster {self.roster_id}"

    @property
    def record(self) -> str:
        base = f"{self.wins}-{self.losses}"
        return f"{base}-{self.ties}" if self.ties else base

    def active_players(self) -> list[str]:
        """Roster minus IR/taxi -- the players who can actually be started."""
        parked = set(self.reserve) | set(self.taxi)
        return [p for p in self.players if p not in parked]


class LeagueState:
    def __init__(self, sleeper: Sleeper, league_id: str, *,
                 user_id: str | None = None, season: str | None = None,
                 force: bool = False):
        self.s = sleeper
        self.league_id = league_id
        self.raw_league = sleeper.league(league_id, force=force)
        if not self.raw_league:
            raise ValueError(f"League {league_id} not found")
        self.rules = LeagueRules.from_league(self.raw_league)
        self.season = season or self.rules.season
        self.state = sleeper.state()
        self.players = PlayerIndex(sleeper)
        self.projections = ProjectionBook(sleeper, self.rules, self.players,
                                          season=self.season)

        self._users = {u["user_id"]: u for u in sleeper.league_users(league_id, force=force)}
        self.teams: dict[int, Team] = {}
        for r in sleeper.rosters(league_id, force=force):
            oid = r.get("owner_id")
            u = self._users.get(oid, {})
            st = r.get("settings") or {}
            self.teams[r["roster_id"]] = Team(
                roster_id=r["roster_id"],
                owner_id=oid,
                display_name=u.get("display_name", "unknown"),
                team_name=(u.get("metadata") or {}).get("team_name", ""),
                players=[str(p) for p in (r.get("players") or [])],
                starters=[str(p) for p in (r.get("starters") or []) if p and p != "0"],
                reserve=[str(p) for p in (r.get("reserve") or [])],
                taxi=[str(p) for p in (r.get("taxi") or [])],
                wins=st.get("wins", 0), losses=st.get("losses", 0), ties=st.get("ties", 0),
                points_for=float(st.get("fpts", 0)) + float(st.get("fpts_decimal", 0)) / 100,
                points_against=float(st.get("fpts_against", 0))
                + float(st.get("fpts_against_decimal", 0)) / 100,
                waiver_budget_used=st.get("waiver_budget_used", 0),
                waiver_position=st.get("waiver_position", 0),
            )

        self.user_id = user_id
        self.my_roster_id = self._find_my_roster(user_id)

    # ---------- identity ----------

    def _find_my_roster(self, user_id: str | None) -> int | None:
        if not user_id:
            return None
        for t in self.teams.values():
            if t.owner_id == user_id:
                return t.roster_id
        return None

    @property
    def me(self) -> Team | None:
        return self.teams.get(self.my_roster_id) if self.my_roster_id else None

    def opponents(self) -> list[Team]:
        return [t for rid, t in self.teams.items() if rid != self.my_roster_id]

    # ---------- weeks ----------

    @property
    def current_week(self) -> int:
        wk = int(self.state.get("week") or 1)
        return max(1, wk)

    @property
    def weeks_remaining(self) -> int:
        end = self.rules.playoff_week_start - 1
        return max(0, end - self.current_week + 1)

    # ---------- ownership ----------

    def owned_ids(self) -> set[str]:
        out: set[str] = set()
        for t in self.teams.values():
            out |= set(t.players)
        return out

    def owner_of(self, pid: str) -> Team | None:
        for t in self.teams.values():
            if pid in t.players:
                return t
        return None

    def free_agents(self, projections: dict[str, float], *,
                    min_points: float = 0.0) -> dict[str, float]:
        """Unowned players who can start in this league, with their projections."""
        owned = self.owned_ids()
        playable = positions_in_play(self.rules)
        out: dict[str, float] = {}
        for pid, pts in projections.items():
            if pid in owned or pts <= min_points:
                continue
            p = self.players.get(pid)
            if not p or p.position not in playable:
                continue
            if p.status and p.status.lower() in {"inactive", "retired"}:
                continue
            # No NFL team means no snaps -- can't help you regardless of projection.
            if p.position != "DEF" and (not p.team or p.team.upper() == "FA"):
                continue
            out[pid] = pts
        return out

    # ---------- convenience ----------

    def positions_map(self, pids) -> dict[str, str]:
        out = {}
        for pid in pids:
            p = self.players.get(pid)
            if p:
                out[pid] = p.position
        return out

    def roster_projection(self, team: Team, projections: dict[str, float]
                          ) -> dict[str, float]:
        return {pid: projections.get(pid, 0.0) for pid in team.active_players()}
