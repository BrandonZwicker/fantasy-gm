"""League-specific rules and scoring.

Everything downstream (lineups, waivers, trades) runs through here, so all
advice reflects THIS league's settings rather than generic PPR rankings.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

# Which real positions may fill each roster slot.
SLOT_ELIGIBILITY: dict[str, set[str]] = {
    "QB": {"QB"},
    "RB": {"RB"},
    "WR": {"WR"},
    "TE": {"TE"},
    "K": {"K"},
    "DEF": {"DEF"},
    "FLEX": {"RB", "WR", "TE"},
    "WRRB_FLEX": {"RB", "WR"},
    "WRRB_WRT": {"RB", "WR", "TE"},
    "REC_FLEX": {"WR", "TE"},
    "SUPER_FLEX": {"QB", "RB", "WR", "TE"},
    "IDP_FLEX": {"DL", "LB", "DB"},
    "DL": {"DL", "DE", "DT"},
    "LB": {"LB"},
    "DB": {"DB", "CB", "S"},
}

# Slots that are not part of the starting lineup.
NON_STARTING = {"BN", "IR", "TAXI"}

# Sleeper's own default PPR scoring, verified against their published points:
# applying this to ACTUAL stats reproduces `pts_ppr` for 100% of QB, RB, WR and
# TE rows. It exists so we can separate "value Sleeper's model projects" from
# "value this league's rules award", which are different things.
REFERENCE_PPR = {
    "pass_yd": 0.04, "pass_td": 4.0, "pass_int": -1.0, "pass_2pt": 2.0,
    "rush_yd": 0.1, "rush_td": 6.0, "rush_2pt": 2.0,
    "rec": 1.0, "rec_yd": 0.1, "rec_td": 6.0, "rec_2pt": 2.0,
    "fum_lost": -2.0, "fum": 0.0, "fum_rec": 2.0,
    "fgm_0_19": 3.0, "fgm_20_29": 3.0, "fgm_30_39": 3.0, "fgm_40_49": 4.0,
    "fgm_50_59": 5.0, "fgm_60p": 6.0, "fgmiss": -1.0,
    "xpm": 1.0, "xpmiss": -1.0,
    "def_td": 6.0, "def_st_td": 6.0, "st_td": 6.0,
    "int": 2.0, "sack": 1.0, "safe": 2.0, "blk_kick": 2.0,
    "ff": 1.0, "def_st_ff": 1.0, "st_ff": 1.0,
    "def_st_fum_rec": 1.0, "st_fum_rec": 1.0,
    "pts_allow_0": 10.0, "pts_allow_1_6": 7.0, "pts_allow_7_13": 4.0,
    "pts_allow_14_20": 1.0, "pts_allow_21_27": 0.0, "pts_allow_28_34": -1.0,
    "pts_allow_35p": -4.0,
}

# Below this the reference dictionary doesn't describe the player (IDP rows
# score ~0 under it), so no residual can be attributed.
_MIN_REFERENCE = 0.5

# Sleeper's headline projection is a separate model from its own components, so
# trusting it is only worth doing where it is actually more accurate. Measured
# against 2025 results (weeks 1-14), adopting it cuts kicker RMSE from 4.84 to
# 4.70, but pushes quarterbacks from 7.53 to 8.00 — their QB number runs about
# 2.2 points hot. So it is applied to kickers only.
CALIBRATED_POSITIONS = {"K"}

# Standard deviation of weekly projection error, measured the same way. Used to
# turn a projected edge into the odds it is real.
PROJECTION_SD = {"QB": 7.5, "RB": 6.8, "WR": 6.8, "TE": 6.0, "K": 4.7, "DEF": 6.0}
DEFAULT_SD = 6.8

# Rough scarcity ordering used to break ties when filling flex slots.
_SLOT_FLEXIBILITY = {"QB": 0, "RB": 0, "WR": 0, "TE": 0, "K": 0, "DEF": 0}


@dataclass
class LeagueRules:
    """Parsed, queryable view of a Sleeper league's configuration."""

    raw: dict
    league_id: str = ""
    name: str = ""
    season: str = ""
    num_teams: int = 0
    roster_positions: list[str] = field(default_factory=list)
    scoring: dict[str, float] = field(default_factory=dict)
    settings: dict = field(default_factory=dict)

    @classmethod
    def from_league(cls, league: dict) -> "LeagueRules":
        return cls(
            raw=league,
            league_id=str(league.get("league_id", "")),
            name=league.get("name", ""),
            season=str(league.get("season", "")),
            num_teams=int(league.get("total_rosters") or 0),
            roster_positions=list(league.get("roster_positions") or []),
            scoring={k: float(v) for k, v in (league.get("scoring_settings") or {}).items()},
            settings=league.get("settings") or {},
        )

    # ---------- scoring ----------

    def score(self, stats: dict[str, float] | None) -> float:
        """Apply this league's scoring dictionary to a raw stat line."""
        if not stats:
            return 0.0
        return round(self._dot(stats, self.scoring), 2)

    @staticmethod
    def _dot(stats: dict, weights: dict) -> float:
        total = 0.0
        for stat, value in stats.items():
            w = weights.get(stat)
            if w:
                try:
                    total += float(value) * w
                except (TypeError, ValueError):
                    continue
        return total

    def score_projection(self, stats: dict[str, float] | None,
                         position: str | None = None) -> float:
        """Score a projection, trusting Sleeper's own headline number.

        Sleeper's projected ``pts_ppr`` is a separately modelled figure, not the
        dot product of its own projected components: on real stats the two agree
        exactly, but on projections quarterbacks diverge by about +2.2 points and
        kickers by +1.5, while running backs and receivers sit near zero. Scoring
        only the itemised components would therefore understate QB and K value
        whenever positions are compared against each other.

        So we keep the league's rules for everything the components explain, and
        add the part of Sleeper's projection they don't:

            league dot-product  +  (Sleeper's pts_ppr - reference dot-product)

        For a league scored like standard PPR this reproduces Sleeper's number
        exactly; for any other league it carries the same unexplained value onto
        that league's own scale.
        """
        if not stats:
            return 0.0
        own = self._dot(stats, self.scoring)
        if position is not None and position not in CALIBRATED_POSITIONS:
            return round(own, 2)
        sleeper = stats.get("pts_ppr")
        if sleeper is None:
            return round(own, 2)
        reference = self._dot(stats, REFERENCE_PPR)
        if reference <= _MIN_REFERENCE:
            return round(own, 2)     # reference doesn't describe this player
        residual = float(sleeper) - reference
        # Guard against a reference that fits badly for some unusual row.
        cap = max(4.0, 0.5 * reference)
        residual = max(-cap, min(cap, residual))
        return round(own + residual, 2)

    # ---------- roster shape ----------

    @property
    def starting_slots(self) -> list[str]:
        return [p for p in self.roster_positions if p not in NON_STARTING]

    @property
    def bench_slots(self) -> int:
        return sum(1 for p in self.roster_positions if p == "BN")

    @property
    def ir_slots(self) -> int:
        return sum(1 for p in self.roster_positions if p == "IR")

    @property
    def taxi_slots(self) -> int:
        return int(self.settings.get("taxi_slots") or 0)

    @property
    def roster_size(self) -> int:
        """Total active roster spots (starters + bench, excluding IR/taxi)."""
        return sum(1 for p in self.roster_positions if p != "IR" and p != "TAXI")

    def slots_of(self, slot: str) -> int:
        return sum(1 for p in self.roster_positions if p == slot)

    def eligible_slots(self, position: str) -> list[str]:
        """Starting slots this position can legally fill."""
        return [s for s in set(self.starting_slots)
                if position in SLOT_ELIGIBILITY.get(s, set())]

    def starters_needed(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for s in self.starting_slots:
            counts[s] = counts.get(s, 0) + 1
        return counts

    # ---------- waivers / transactions ----------

    @property
    def waiver_type(self) -> str:
        """'faab', 'rolling', 'reverse' or 'none'."""
        wt = self.settings.get("waiver_type")
        if wt == 2:
            return "faab"
        if wt == 1:
            return "rolling"
        if wt == 0:
            return "reverse"
        return "none"

    @property
    def uses_faab(self) -> bool:
        return self.waiver_type == "faab" and self.waiver_budget > 0

    @property
    def waiver_budget(self) -> int:
        return int(self.settings.get("waiver_budget") or 0)

    @property
    def waiver_clear_days(self) -> int:
        return int(self.settings.get("waiver_clear_days") or 2)

    @property
    def waiver_day_of_week(self) -> int:
        # Sleeper: 0 = Tuesday ... 6 = Monday (day waivers process)
        return int(self.settings.get("waiver_day_of_week") or 2)

    @property
    def trade_deadline_week(self) -> int:
        return int(self.settings.get("trade_deadline") or 99)

    @property
    def playoff_week_start(self) -> int:
        return int(self.settings.get("playoff_week_start") or 15)

    @property
    def playoff_teams(self) -> int:
        return int(self.settings.get("playoff_teams") or 6)

    # ---------- league character ----------

    @property
    def ppr(self) -> float:
        return float(self.scoring.get("rec", 0.0))

    @property
    def te_premium(self) -> float:
        """Extra points per TE reception above the base PPR value."""
        return round(float(self.scoring.get("bonus_rec_te", 0.0)), 2)

    @property
    def is_superflex(self) -> bool:
        return any(s == "SUPER_FLEX" for s in self.starting_slots) or self.slots_of("QB") > 1

    @property
    def is_idp(self) -> bool:
        return any(s in {"DL", "LB", "DB", "IDP_FLEX"} for s in self.starting_slots)

    @property
    def is_dynasty(self) -> bool:
        t = (self.settings.get("type") or 0)
        return t == 2 or self.taxi_slots > 0

    @property
    def is_keeper(self) -> bool:
        return (self.settings.get("type") or 0) == 1

    @property
    def league_format(self) -> str:
        if self.is_dynasty:
            return "dynasty"
        if self.is_keeper:
            return "keeper"
        return "redraft"

    @property
    def ppr_label(self) -> str:
        p = self.ppr
        if p == 0:
            return "standard (non-PPR)"
        if p == 1:
            return "full PPR"
        if p == 0.5:
            return "half PPR"
        return f"{p} PPR"

    def describe(self) -> list[str]:
        """Human-readable summary of the settings that actually drive strategy."""
        out = [
            f"{self.num_teams}-team {self.league_format}, {self.ppr_label}",
            f"Starters: {self.lineup_string()}",
            f"Bench {self.bench_slots}"
            + (f", IR {self.ir_slots}" if self.ir_slots else "")
            + (f", taxi {self.taxi_slots}" if self.taxi_slots else ""),
        ]
        if self.is_superflex:
            out.append("SUPERFLEX — QBs are dramatically more valuable here")
        if self.te_premium:
            out.append(f"TE premium (+{self.te_premium}/rec) — TEs gain real value")
        if self.is_idp:
            out.append("IDP league — individual defensive players start")
        if self.uses_faab:
            out.append(f"FAAB waivers, ${self.waiver_budget} season budget")
        elif self.waiver_type == "reverse":
            out.append("Reverse-standings waivers — priority, no bidding")
        elif self.waiver_type == "rolling":
            out.append("Rolling waiver priority — no bidding")
        else:
            out.append("No waivers — free agents are first-come, first-served")
        out.append(
            f"Trade deadline week {self.trade_deadline_week}, "
            f"playoffs start week {self.playoff_week_start} ({self.playoff_teams} teams)"
        )
        return out

    def lineup_string(self) -> str:
        counts = self.starters_needed()
        order = ["QB", "RB", "WR", "TE", "FLEX", "WRRB_FLEX", "REC_FLEX",
                 "SUPER_FLEX", "DL", "LB", "DB", "IDP_FLEX", "K", "DEF"]
        parts = []
        for slot in order:
            n = counts.get(slot, 0)
            if n:
                parts.append(f"{n}{slot}" if n > 1 else slot)
        for slot, n in counts.items():
            if slot not in order:
                parts.append(f"{n}{slot}" if n > 1 else slot)
        return " / ".join(parts)


def positions_in_play(rules: LeagueRules) -> set[str]:
    """Every real position that can start in this league."""
    pos: set[str] = set()
    for slot in rules.starting_slots:
        pos |= SLOT_ELIGIBILITY.get(slot, {slot})
    return pos
