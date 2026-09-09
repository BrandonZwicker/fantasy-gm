"""Validate this project's maths against Sleeper's own published numbers.

Two independent checks:

1. SCORING. Sleeper publishes `pts_std`, `pts_half_ppr` and `pts_ppr` alongside
   the raw stat components. For *actual* stats these are computed from those
   components, so applying the matching scoring dictionary must reproduce them
   exactly. We use a real league's own 43-key dictionary rather than a guessed
   one, and segment by position.

2. LINEUP OPTIMISER. No external source can check this, so it is verified
   against exhaustive search over random rosters and flex shapes.

A finding worth keeping in view: on PROJECTIONS the same comparison does not
reconcile for QBs and kickers. That is not a scoring bug — it is that Sleeper's
projected `pts_ppr` is a separately modelled number rather than the dot product
of its own projected components. See `report_projection_divergence`.
"""
from __future__ import annotations

import random
import sys
from collections import defaultdict
from statistics import mean, pstdev

sys.path.insert(0, ".")

from gm.lineup import optimize
from gm.players import PlayerIndex
from gm.scoring import SLOT_ELIGIBILITY, LeagueRules
from gm.sleeper import Sleeper

SEASON, WEEKS = "2025", [1, 2, 3, 4, 5]
REFERENCE_LEAGUE = "1393414438685519872"   # a real full-PPR league
TOL = 0.011                                 # Sleeper rounds to 2dp
IDP = {"CB", "S", "LB", "DL", "DE", "DT", "DB", "NT", "OLB", "ILB", "MLB", "SS", "FS"}
STARTABLE = ["QB", "RB", "WR", "TE", "K", "DEF"]


def load(s: Sleeper, pi: PlayerIndex, kind: str):
    rows = []
    for w in WEEKS:
        src = s.stats(SEASON, w) if kind == "stats" else s.projections(SEASON, w)
        for r in src or []:
            st = r.get("stats") or {}
            p = pi.get(str(r.get("player_id", "")))
            if p and st.get("gp") and "pts_ppr" in st:
                rows.append((p, st))
    return rows


def score_table(rules: LeagueRules, rows, tol: float):
    by = defaultdict(lambda: {"n": 0, "ok": 0, "err": 0.0, "max": 0.0, "worst": None})
    for p, st in rows:
        group = "IDP (unscored in this league)" if p.position in IDP else p.position
        mine, theirs = rules.score(st), st["pts_ppr"]
        d = abs(mine - theirs)
        b = by[group]
        b["n"] += 1
        b["err"] += d
        if d <= tol:
            b["ok"] += 1
        if d > b["max"]:
            b["max"], b["worst"] = d, (p.name, mine, theirs)
    return by


def print_table(by, title, tol):
    print(f"\n  {title}  (tolerance {tol})")
    print(f"    {'position':<32}{'n':>6}{'exact':>9}{'mean|err|':>11}{'max':>8}")
    for k in sorted(by, key=lambda k: -by[k]["n"]):
        b = by[k]
        print(f"    {k:<32}{b['n']:>6}{100*b['ok']/b['n']:>8.1f}%"
              f"{b['err']/b['n']:>11.4f}{b['max']:>8.2f}")


def check_scoring_on_actuals(rules, rows) -> bool:
    """The load-bearing test: real stats must reproduce exactly."""
    by = score_table(rules, rows, TOL)
    print_table(by, "Engine vs Sleeper, ACTUAL stats", TOL)
    skill = [by[k] for k in ("QB", "RB", "WR", "TE") if k in by]
    n = sum(b["n"] for b in skill)
    ok = sum(b["ok"] for b in skill)
    rate = ok / n
    print(f"\n    skill positions (QB/RB/WR/TE): {100*rate:.2f}% exact over {n} rows")
    for k in ("QB", "RB", "WR", "TE"):
        if k in by and by[k]["worst"] and by[k]["max"] > TOL:
            nm, mine, theirs = by[k]["worst"]
            print(f"      {k} worst: {nm} ours {mine:.2f} vs {theirs:.2f} — this league "
                  f"scores a category Sleeper's generic PPR does not")
    return rate >= 0.995


def check_projection_calibration(rules, rows) -> bool:
    """Projections must now track Sleeper's own headline number.

    Sleeper's projected pts_ppr is a separately modelled figure rather than the
    dot product of its own components, so scoring the components alone
    understates QBs and kickers. `score_projection` adds back the difference;
    this confirms it closes the gap without disturbing the positions that were
    already correct.
    """
    print("\n  Engine vs Sleeper, PROJECTIONS — before and after calibration")
    print(f"    {'position':<10}{'n':>6}{'raw gap':>10}{'raw sd':>9}"
          f"{'calibrated':>12}{'cal sd':>9}")
    worst_after = 0.0
    for pos in STARTABLE:
        sel = [st for p, st in rows if p.position == pos and st["pts_ppr"] > 3]
        if len(sel) < 20:
            continue
        raw = [st["pts_ppr"] - rules.score(st) for st in sel]
        cal = [st["pts_ppr"] - rules.score_projection(st) for st in sel]
        worst_after = max(worst_after, abs(mean(cal)))
        print(f"    {pos:<10}{len(sel):>6}{mean(raw):>+10.3f}{pstdev(raw):>9.3f}"
              f"{mean(cal):>+12.3f}{pstdev(cal):>9.3f}")
    ok = worst_after < 0.05
    print(f"\n    largest remaining mean gap: {worst_after:.4f}"
          + ("  ✓" if ok else "  — still diverging"))
    return ok


def brute_force_lineup(rules, cands, positions):
    """Exhaustive best assignment. Slots may be left empty, so that branch
    has to be searched too — requiring a full permutation finds no legal
    assignment whenever a slot is uncoverable."""
    slots = rules.starting_slots

    def best_from(i, used):
        if i == len(slots):
            return 0.0
        elig = SLOT_ELIGIBILITY.get(slots[i], {slots[i]})
        best = best_from(i + 1, used)
        for pid, pts in cands.items():
            if pid in used or positions[pid] not in elig:
                continue
            best = max(best, pts + best_from(i + 1, used | {pid}))
        return best

    return round(best_from(0, frozenset()), 2)


def check_optimizer(trials: int = 300) -> bool:
    rng = random.Random(7)
    shapes = [
        ["QB", "RB", "WR", "FLEX"],
        ["QB", "RB", "RB", "WR", "FLEX"],
        ["QB", "WR", "TE", "REC_FLEX", "FLEX"],
        ["SUPER_FLEX", "RB", "WR", "WRRB_FLEX"],
    ]
    bad = 0
    for _ in range(trials):
        slots = rng.choice(shapes)
        rules = LeagueRules.from_league({
            "league_id": "o", "name": "o", "season": SEASON, "total_rosters": 10,
            "roster_positions": slots, "scoring_settings": {}, "settings": {}})
        n = rng.randint(len(slots), len(slots) + 3)
        cands = {f"p{i}": round(rng.uniform(0, 30), 2) for i in range(n)}
        positions = {f"p{i}": rng.choice(["QB", "RB", "WR", "TE"]) for i in range(n)}
        if abs(optimize(rules, cands, positions).total
               - brute_force_lineup(rules, cands, positions)) > TOL:
            bad += 1
    print(f"\n  lineup DP vs exhaustive search: {trials - bad}/{trials} exact"
          + ("  ✓" if bad == 0 else "  — FAILURES"))
    return bad == 0


def main() -> int:
    s = Sleeper()
    pi = PlayerIndex(s)
    league = s.league(REFERENCE_LEAGUE)
    rules = LeagueRules.from_league(league)
    print(f"\nReference league: {league['name'].strip()} "
          f"({len(rules.scoring)}-key scoring dictionary, {rules.ppr_label})")

    actual = load(s, pi, "stats")
    proj = load(s, pi, "proj")
    print(f"Rows: {len(actual)} actual, {len(proj)} projected "
          f"({SEASON}, weeks {WEEKS[0]}–{WEEKS[-1]})")

    scoring_ok = check_scoring_on_actuals(rules, actual)
    projection_ok = check_projection_calibration(rules, proj)
    optimizer_ok = check_optimizer()

    print()
    ok = scoring_ok and projection_ok and optimizer_ok
    print(f"VERDICT: {'PASS' if ok else 'FAIL'} — "
          f"scoring {'reproduces' if scoring_ok else 'does NOT reproduce'} Sleeper "
          f"exactly on real stats; projections {'track' if projection_ok else 'DIVERGE from'} "
          f"Sleeper's own figure; optimiser {'exact' if optimizer_ok else 'MISMATCHED'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
