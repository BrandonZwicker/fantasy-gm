#!/usr/bin/env python
"""fantasy-gm command line.

  python cli.py link <sleeper_username>   # find your leagues, pick one
  python cli.py report                    # full recommendation report
  python cli.py watch [--every 900]       # poll and print new changes
  python cli.py serve                     # start the web dashboard
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from gm import db
from gm.config import Config
from gm.recommend import build_report
from gm.sleeper import Sleeper

C = {"b": "\033[1m", "d": "\033[2m", "r": "\033[31m", "y": "\033[33m",
     "g": "\033[32m", "c": "\033[36m", "x": "\033[0m"}


def _p(s=""):
    print(s)


def cmd_link(args) -> int:
    s = Sleeper()
    user = s.user(args.username)
    if not user:
        _p(f"{C['r']}No Sleeper user named '{args.username}'.{C['x']}")
        return 1
    season = args.season or s.state()["season"]
    leagues = s.user_leagues(user["user_id"], season)
    if not leagues:
        _p(f"No {season} leagues found for {args.username}.")
        return 1

    _p(f"\n{C['b']}Leagues for {args.username} ({season}){C['x']}")
    for i, lg in enumerate(leagues, 1):
        _p(f"  {i}. {lg['name']}  —  {lg['total_rosters']} teams  "
           f"[{lg['league_id']}]")

    if len(leagues) == 1:
        choice = 0
        _p(f"\nAuto-selecting the only league.")
    else:
        raw = input("\nWhich league? (number) ").strip()
        if not raw.isdigit() or not (1 <= int(raw) <= len(leagues)):
            _p("Cancelled.")
            return 1
        choice = int(raw) - 1

    lg = leagues[choice]
    cfg = Config(username=args.username, user_id=user["user_id"],
                 league_id=lg["league_id"], league_name=lg["name"], season=season)
    cfg.save()
    _p(f"\n{C['g']}Linked:{C['x']} {lg['name']} ({lg['league_id']})")
    _p("Run `python cli.py report` for your first set of recommendations.")
    return 0


def _print_report(r) -> None:
    _p(f"\n{C['b']}{'=' * 72}{C['x']}")
    _p(f"{C['b']}{r.league_name}{C['x']}  —  Week {r.week}  —  {r.generated_at}")
    _p(f"Your team: {C['c']}{r.my_team}{C['x']}  ({r.record})")
    _p(f"{C['b']}{'=' * 72}{C['x']}")

    _p(f"\n{C['b']}LEAGUE SETTINGS DRIVING THIS ADVICE{C['x']}")
    for line in r.settings_summary:
        _p(f"  · {line}")

    _p(f"\n{C['b']}DO THIS NOW{C['x']}")
    if not r.actions:
        _p(f"  {C['g']}Nothing to change — roster and lineup are optimal.{C['x']}")
    for a in r.actions:
        col = C["r"] if a.priority == 1 else C["y"] if a.priority == 2 else C["x"]
        _p(f"  {col}[{a.kind:9}] {a.headline}{C['x']}")
        if a.detail:
            _p(f"              {C['d']}{a.detail}{C['x']}")

    if r.lineup:
        _p(f"\n{C['b']}OPTIMAL WEEK {r.week} LINEUP{C['x']}  "
           f"(projected {r.lineup.total:.1f} pts"
           + (f", {C['g']}+{r.lineup_gain:.1f} vs your current lineup{C['x']}"
              if r.lineup_gain > 0.1 else ", already optimal") + ")")
        for s in r.lineup.slots:
            name = s.player_id or "— EMPTY —"
            _p(f"  {s.slot:<11} {name:<28} {s.points:6.1f}")

    if r.waivers:
        _p(f"\n{C['b']}WAIVER TARGETS{C['x']}  (FAAB left: ${r.faab_left} · "
           f"next run: {r.next_waiver})")
        for w in r.waivers[:8]:
            bid = f"${w.faab_bid}" if w.faab_bid else "-"
            _p(f"  {bid:>5}  {w.name:<24} {w.position:<4} "
               f"+{w.marginal_ros:5.1f} ROS  net {w.net_gain:5.1f}"
               + (f"  (drop {w.drop_name})" if w.drop_id else ""))

    if r.trades:
        _p(f"\n{C['b']}TRADE OPPORTUNITIES{C['x']}")
        for t in r.trades:
            _p(f"  {C['c']}{t.partner_name}{C['x']}: {t.summary}")
            _p(f"      you +{t.my_gain:.1f} / them +{t.their_gain:.1f} "
               f"· {t.acceptance.upper()} to be accepted (value ratio {t.value_ratio:.2f}x)")
            _p(f"      {C['d']}{t.rationale}{C['x']}")

    if r.changes:
        _p(f"\n{C['b']}WHAT CHANGED SINCE LAST CHECK{C['x']}")
        for c in r.changes[:15]:
            col = C["r"] if c.severity == "critical" else C["y"] if c.severity == "high" else C["d"]
            flag = " *YOU*" if c.affects_me else ""
            _p(f"  {col}[{c.severity:8}]{C['x']} {c.headline}{flag}")

    _p(f"\n{C['b']}DEADLINES{C['x']}")
    for d in r.deadlines:
        _p(f"  · {d}")
    _p()


def cmd_report(args) -> int:
    cfg = Config.load()
    if not cfg.linked:
        _p(f"{C['r']}Not linked yet.{C['x']} Run: python cli.py link <your_sleeper_username>")
        return 1
    r = build_report(cfg.league_id, cfg.user_id, force=args.force,
                     do_trades=not args.no_trades)
    _print_report(r)
    return 0


def cmd_watch(args) -> int:
    cfg = Config.load()
    if not cfg.linked:
        _p(f"{C['r']}Not linked yet.{C['x']} Run: python cli.py link <username>")
        return 1
    _p(f"Watching {cfg.league_name} every {args.every}s. Ctrl-C to stop.")
    con = db.connect()
    while True:
        try:
            r = build_report(cfg.league_id, cfg.user_id, force=True,
                             do_trades=False, con=con)
            urgent = [a for a in r.actions if a.priority <= 2]
            stamp = time.strftime("%H:%M:%S")
            if r.changes or urgent:
                _p(f"\n{C['b']}--- {stamp} ---{C['x']}")
                for c in r.changes[:10]:
                    _p(f"  {C['y']}[{c.severity}]{C['x']} {c.headline}")
                for a in urgent[:10]:
                    _p(f"  {C['r']}[{a.kind}]{C['x']} {a.headline}")
            else:
                _p(f"{C['d']}{stamp} — no changes{C['x']}")
        except KeyboardInterrupt:
            raise
        except Exception as e:
            _p(f"{C['r']}poll failed: {e}{C['x']}")
        try:
            time.sleep(args.every)
        except KeyboardInterrupt:
            _p("\nstopped.")
            return 0


def cmd_digest(args) -> int:
    """Short markdown digest for scheduled notifications."""
    import os
    cfg = Config.load()
    league_id = args.league or os.environ.get("SLEEPER_LEAGUE_ID") or cfg.league_id
    user_id = cfg.user_id
    username = args.username or os.environ.get("SLEEPER_USERNAME") or cfg.username
    if username and not user_id:
        u = Sleeper().user(username)
        user_id = u["user_id"] if u else None
    if not (league_id and user_id):
        _p("Set SLEEPER_LEAGUE_ID and SLEEPER_USERNAME, or run `cli.py link`.")
        return 1

    r = build_report(league_id, user_id, force=True, risk=args.risk)
    urgent = [a for a in r.actions if a.priority <= args.max_priority]

    lines = [f"## {r.league_name.strip()} — week {r.week}", ""]
    if r.lineup_gain > 0.1:
        lines.append(f"**{r.lineup_gain:.1f} projected points** available from lineup changes.")
        lines.append("")
    if not urgent:
        lines.append("Nothing needs doing right now.")
    for a in urgent:
        unit = "this week" if a.kind == "start_sit" else "rest of season"
        conf = ""
        lines.append(f"- **{a.tier_label}** — {a.headline}")
        lines.append(f"  - +{a.impact:.1f} pts {unit}{conf} · {a.horizon}")
        if a.detail:
            lines.append(f"  - {a.detail}")
    if r.held_back:
        lines.append("")
        lines.append(f"_{r.held_back} smaller move(s) skipped at {args.risk} risk._")
    lines.append("")
    lines.append(f"Waivers: {r.next_waiver}")
    if league_id and not league_id.startswith("EXAMPLE"):
        lines.append(f"\nhttps://sleeper.com/leagues/{league_id}")

    out = "\n".join(lines)
    _p(out)
    if args.out:
        Path(args.out).write_text(out)
    # Non-zero when there is nothing worth reporting, so a workflow can skip.
    return 0 if urgent else 2


def cmd_serve(args) -> int:
    import uvicorn
    _p(f"Dashboard: http://{args.host}:{args.port}")
    uvicorn.run("gm.api:app", host=args.host, port=args.port,
                reload=args.reload, log_level="warning")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="fantasy-gm")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("link", help="link your Sleeper account and league")
    p.add_argument("username")
    p.add_argument("--season")
    p.set_defaults(fn=cmd_link)

    p = sub.add_parser("report", help="print recommendations")
    p.add_argument("--force", action="store_true", help="bypass cache")
    p.add_argument("--no-trades", action="store_true")
    p.set_defaults(fn=cmd_report)

    p = sub.add_parser("watch", help="poll for changes")
    p.add_argument("--every", type=int, default=900)
    p.set_defaults(fn=cmd_watch)

    p = sub.add_parser("digest", help="short digest for scheduled alerts")
    p.add_argument("--league")
    p.add_argument("--username")
    p.add_argument("--risk", default="balanced",
                   choices=["cautious", "balanced", "aggressive"])
    p.add_argument("--max-priority", type=int, default=2,
                   help="only report actions at this tier or more urgent")
    p.add_argument("--out", help="also write the digest to this file")
    p.set_defaults(fn=cmd_digest)

    p = sub.add_parser("serve", help="run the web dashboard")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reload", action="store_true",
                   help="restart on code changes (development)")
    p.set_defaults(fn=cmd_serve)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
