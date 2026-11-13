"""The report is a plan: steps done in order, none contradicting another.

Builds the synthetic league, pushes my roster two over the limit, and checks:
  - the plan opens with the roster fix, and it gets the roster legal
  - nobody cut in the fix shows up anywhere later in the plan
  - nobody is started twice, benched twice, or both claimed and traded away
  - the lineup steps, applied in order, land exactly on the lineup shown
"""
import sys
sys.path.insert(0, ".")

from gm import db
from gm.sleeper import Sleeper
from tests import synthetic

s = Sleeper()
league, rosters, users, my_uid = synthetic.build(s, my_slot=3)
mine = next(r for r in rosters if r["owner_id"] == my_uid)

# Two of the best leftover players onto my bench: 2 over the limit.
owned = {p for r in rosters for p in r["players"]}
from gm.players import PlayerIndex
from gm.projections import ProjectionBook
from gm.scoring import LeagueRules
rules = LeagueRules.from_league(league)
pi = PlayerIndex(s)
totals = ProjectionBook(s, rules, pi, season=synthetic.SEASON).season_totals()
spare = [pid for pid, _ in sorted(totals.items(), key=lambda kv: -kv[1])
         if pid not in owned and pi.get(pid) and pi.get(pid).position in {"RB", "WR"}][:2]
mine["players"] = mine["players"] + spare
synthetic.patch(Sleeper, league, rosters, users)

from gm.recommend import build_report
r = build_report("SYNTH1", my_uid, do_trades=True, con=db.connect(":memory:"))

fail = []
def check(ok, msg):
    print(("  ok   " if ok else "  FAIL ") + msg)
    if not ok:
        fail.append(msg)

fix = r.roster_fix
check(fix is not None and fix.over_by == 2, f"over the limit by 2 (got {fix.over_by if fix else None})")
cut = {d.player_id for d in fix.drops}
check(len(cut) + len(fix.to_ir) == 2, "the fix clears exactly two spots")
check(all(a.kind == "roster" for a in r.actions[:len(cut) + len(fix.to_ir)]),
      "roster steps come first")

for i, a in enumerate(r.actions, 1):
    print(f"   {i}. {a.headline}")

later = r.actions[len(cut) + len(fix.to_ir):]
touched = set()
for a in later:
    p = a.payload
    touched.update(x for x in (p.get("player_id"), p.get("bench"), p.get("drop_id")) if x)
    touched.update(p.get("send") or [])
check(not (touched & cut), "no player cut in the fix appears in a later step")

starts = [a.payload["player_id"] for a in r.actions if a.kind == "start_sit"]
benched = [a.payload["bench"] for a in r.actions if a.kind == "start_sit" and a.payload.get("bench")]
check(len(starts) == len(set(starts)), "no player is started twice")
check(len(benched) == len(set(benched)), "no player is benched twice")
check(not (set(starts) & set(benched)), "no player is both started and benched")

claimed = {a.payload["player_id"] for a in r.actions if a.kind == "waiver"}
sent = {p for a in r.actions if a.kind == "trade" for p in a.payload["send"]}
check(not (claimed & sent), "nobody is claimed and then traded away")
claim_drops = {a.payload.get("drop_id") for a in r.actions if a.kind == "waiver"} - {None}
check(not (claim_drops & sent), "nobody is dropped for a claim and also offered in a trade")

# Replay the lineup steps on the current lineup.
lineup = [p if p and p != "0" else None for p in r.current_starters]
final = {s_.player_id for s_ in r.lineup.slots if s_.player_id}
now = {p for p in lineup if p}
for a in r.actions:
    if a.kind != "start_sit":
        continue
    if a.payload.get("bench"):
        now.discard(a.payload["bench"])
    now.add(a.payload["player_id"])
check(now == final, "lineup steps, applied in order, give the lineup shown")

print("\n" + ("✅ plan OK" if not fail else f"❌ {len(fail)} failed"))
sys.exit(1 if fail else 0)
