"""End-to-end smoke test over the synthetic league."""
import sys, time
sys.path.insert(0, ".")

from gm import db
from gm.sleeper import Sleeper
from tests import synthetic

t0 = time.time()
s = Sleeper()
league, rosters, users, my_uid = synthetic.build(s, my_slot=3)
synthetic.patch(Sleeper, league, rosters, users)
print(f"synthetic league built in {time.time()-t0:.1f}s")

from gm.recommend import build_report
con = db.connect(":memory:")

t0 = time.time()
r = build_report("SYNTH1", my_uid, do_trades=True, con=con)
print(f"report generated in {time.time()-t0:.1f}s\n")

print("=" * 70)
print(f"{r.league_name} | week {r.week} | {r.my_team} ({r.record})")
for line in r.settings_summary:
    print("  ·", line)

print(f"\nOPTIMAL LINEUP ({r.lineup.total:.1f} pts, gain vs current {r.lineup_gain:+.1f})")
from gm.players import PlayerIndex
pi = PlayerIndex(s)
for sl in r.lineup.slots:
    nm = pi.name_of(sl.player_id) if sl.player_id else "— EMPTY —"
    print(f"  {sl.slot:<10} {nm:<40} {sl.points:6.1f}")

print(f"\nACTIONS ({len(r.actions)}):")
for a in r.actions[:12]:
    print(f"  P{a.priority} [{a.kind:9}] {a.headline}")
    if a.detail:
        print(f"        {a.detail[:110]}")

print(f"\nWAIVERS (FAAB left ${r.faab_left}, next {r.next_waiver}):")
for w in r.waivers[:6]:
    print(f"  ${w.faab_bid:<4} {w.name:<24}{w.position:<4} +{w.marginal_ros:5.1f} ROS "
          f"net {w.net_gain:5.1f}" + (f" | drop {w.drop_name}" if w.drop_id else ""))

print(f"\nTRADES ({len(r.trades)}):")
for t in r.trades[:5]:
    print(f"  {t.partner_name}: {t.summary}")
    print(f"     me +{t.my_gain:.1f} / them +{t.their_gain:.1f} | {t.acceptance} "
          f"(ratio {t.value_ratio}x)")

print(f"\nDROP CANDIDATES:")
for d in r.drops[:5]:
    print(f"  {d.name:<40} costs {d.cost:5.1f} ROS pts")

print(f"\nCHANGES: {len(r.changes)} | DEADLINES: {r.deadlines}")
assert r.lineup and r.lineup.total > 0, "lineup failed"
assert r.actions, "no actions produced"
print("\n✅ pipeline OK")
