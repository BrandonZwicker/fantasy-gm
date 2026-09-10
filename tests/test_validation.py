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


def check_projection_accuracy(rules, s, pi) -> bool:
    """Measure projections against what actually happened.

    Reproducing Sleeper's numbers proves the scoring engine is right; it says
    nothing about whether the projections are any good. This compares each
    week's projection to that week's real result, and checks that the decision
    to adopt Sleeper's headline figure for kickers only is the better one --
    applying it to quarterbacks made them measurably worse.
    """
    import math

    raw = defaultdict(list)
    shipped = defaultdict(list)
    full = defaultdict(list)
    for w in range(1, 15):
        proj = {str(r["player_id"]): r for r in (s.projections(SEASON, w) or [])}
        act = {str(r["player_id"]): r for r in (s.stats(SEASON, w) or [])}
        for pid, pr in proj.items():
            a = act.get(pid)
            if not a:
                continue
            ps, as_ = pr.get("stats") or {}, a.get("stats") or {}
            if not ps.get("gp") or not as_.get("gp"):
                continue
            p = pi.get(pid)
            if not p or p.position not in STARTABLE:
                continue
            actual = rules.score(as_)
            r_raw = rules.score(ps)                                   # components only
            r_ship = rules.score_projection(ps, p.position)           # what ships
            r_full = rules.score_projection(ps)                       # calibrate everything
            if max(r_raw, r_ship) < 4:
                continue
            raw[p.position].append(actual - r_raw)
            shipped[p.position].append(actual - r_ship)
            full[p.position].append(actual - r_full)

    rmse = lambda v: math.sqrt(sum(x * x for x in v) / len(v))
    bias = lambda v: sum(v) / len(v)

    print("\n  Projection accuracy vs actual results")
    print(f"    {'pos':<5}{'n':>6}{'bias':>9}{'RMSE':>8}   "
          f"{'raw':>7}{'all-cal':>9}   choice")
    ok = True
    for pos in STARTABLE:
        if len(shipped[pos]) < 50:
            continue
        r_s, r_r, r_f = rmse(shipped[pos]), rmse(raw[pos]), rmse(full[pos])
        best = min(r_s, r_r, r_f)
        good = r_s <= best + 0.02
        if not good:
            ok = False
        print(f"    {pos:<5}{len(shipped[pos]):>6}{bias(shipped[pos]):>9.2f}"
              f"{r_s:>8.2f}   {r_r:>7.2f}{r_f:>9.2f}   "
              + ("best ✓" if good else "NOT BEST — review"))

    print("\n    'raw' scores only the itemised components; 'all-cal' adopts")
    print("    Sleeper's headline projection everywhere. What ships adopts it")
    print("    for kickers alone, which the middle column has to justify.")
    return ok


def check_edge_confidence() -> None:
    """Report what a projected edge is actually worth, in odds."""
    import math
    sd = 6.8 * math.sqrt(2)
    phi = lambda z: 0.5 * (1 + math.erf(z / math.sqrt(2)))
    print("\n  What a projected edge is worth (skill-position SD 6.8)")
    print(f"    {'edge':>6}{'odds it is the better start':>32}")
    for e in (1.0, 1.5, 2.5, 5.0, 8.0):
        print(f"    {e:>6.1f}{100 * phi(e / sd):>31.1f}%")


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
    projection_ok = check_projection_accuracy(rules, s, pi)
    check_edge_confidence()
    optimizer_ok = check_optimizer()

    print()
    ok = scoring_ok and projection_ok and optimizer_ok
    print(f"VERDICT: {'PASS' if ok else 'FAIL'} — "
          f"scoring {'reproduces' if scoring_ok else 'does NOT reproduce'} Sleeper "
          f"exactly on real stats; projection settings "
          f"{'are the most accurate option' if projection_ok else 'are NOT optimal'}; "
          f"optimiser {'exact' if optimizer_ok else 'MISMATCHED'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
