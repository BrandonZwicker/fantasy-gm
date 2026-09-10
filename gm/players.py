"""Player index built from Sleeper's full NFL dump."""
from __future__ import annotations

from dataclasses import dataclass

from .sleeper import Sleeper

# Injury handling.
#
# We deliberately do NOT shade projections for players who might still play.
# There is no way to calibrate such a multiplier from this data: Sleeper stamps
# a player's *current* injury status onto every historical projection row (663
# of 664 tagged players carry an identical tag across weeks 1, 5, 9 and 13), so
# past rows cannot tell us what a "Questionable" tag was historically worth.
#
# Inventing a discount also breaks the thing users check against: a 25% haircut
# turned a 12.7-point projection into 9.5 with nothing on screen explaining the
# gap, and the difference was large enough to flip start/sit advice.
#
# So the rule is now factual rather than estimated: a player who will not play
# is worth zero this week, a player who might play is worth his projection, and
# the designation is shown so the decision stays with the user.

# Designations meaning the player will not suit up this week.
OUT_THIS_WEEK = {"Out", "IR", "PUP", "Sus", "NA", "DNR", "Doubtful"}

# Designations that also depress value beyond this week.
LONG_TERM = {"IR", "PUP", "NA", "DNR", "Sus"}


@dataclass
class Player:
    player_id: str
    name: str
    position: str
    team: str | None
    age: int | None
    injury_status: str | None
    status: str | None
    years_exp: int | None
    depth_chart_order: int | None
    number: int | None

    @property
    def is_active(self) -> bool:
        return (self.status or "").lower() in {"active", ""} or self.status is None

    @property
    def plays_this_week(self) -> bool:
        """False only when the designation means he is not suiting up."""
        return (self.injury_status or "") not in OUT_THIS_WEEK

    @property
    def availability(self) -> float:
        """Weekly multiplier: 1 if he might play, 0 if he definitely won't."""
        return 1.0 if self.plays_this_week else 0.0

    @property
    def ros_multiplier(self) -> float:
        """Rest-of-season multiplier. Only long-term designations reduce it;
        a week-to-week tag says nothing about November."""
        return 0.45 if (self.injury_status or "") in LONG_TERM else 1.0

    @property
    def injury_note(self) -> str:
        if self.injury_status:
            return self.injury_status
        if self.status and self.status.lower() not in {"active"}:
            return self.status
        return ""

    def label(self) -> str:
        t = self.team or "FA"
        n = f"{self.name} ({self.position} - {t})"
        return f"{n} [{self.injury_note}]" if self.injury_note else n


class PlayerIndex:
    def __init__(self, sleeper: Sleeper, force: bool = False):
        self._raw = sleeper.players(force=force)
        self._cache: dict[str, Player] = {}

    def __contains__(self, pid: str) -> bool:
        return str(pid) in self._raw

    def get(self, pid: str) -> Player | None:
        pid = str(pid)
        if pid in self._cache:
            return self._cache[pid]
        d = self._raw.get(pid)
        if not d:
            # Team defenses come through as e.g. "SF" with sparse records.
            if len(pid) <= 3 and pid.isalpha():
                p = Player(pid, f"{pid} Defense", "DEF", pid.upper(),
                           None, None, None, None, None, None)
                self._cache[pid] = p
                return p
            return None
        name = (d.get("full_name")
                or " ".join(filter(None, [d.get("first_name"), d.get("last_name")]))
                or d.get("last_name") or pid)
        pos = d.get("position") or (d.get("fantasy_positions") or ["?"])[0]
        p = Player(
            player_id=pid,
            name=name.strip(),
            position=pos or "?",
            team=d.get("team"),
            age=d.get("age"),
            injury_status=d.get("injury_status"),
            status=d.get("status"),
            years_exp=d.get("years_exp"),
            depth_chart_order=d.get("depth_chart_order"),
            number=d.get("number"),
        )
        self._cache[pid] = p
        return p

    def name_of(self, pid: str) -> str:
        p = self.get(pid)
        return p.label() if p else f"player:{pid}"

    def all_ids(self) -> list[str]:
        return list(self._raw.keys())
