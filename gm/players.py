"""Player index built from Sleeper's full NFL dump."""
from __future__ import annotations

from dataclasses import dataclass

from .sleeper import Sleeper

# Injury designations, worst to best. Used to discount projections.
INJURY_RISK = {
    "Out": 1.0, "IR": 1.0, "PUP": 1.0, "Sus": 1.0, "NA": 1.0, "DNR": 1.0,
    "Doubtful": 0.75, "Questionable": 0.25, "Probable": 0.05,
}


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
    def availability(self) -> float:
        """0..1 multiplier on projection for injury designation."""
        return 1.0 - INJURY_RISK.get(self.injury_status or "", 0.0)

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
