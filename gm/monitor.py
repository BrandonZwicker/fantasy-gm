"""Change detection: diff league and NFL state between polls."""
from __future__ import annotations

import time
from dataclasses import dataclass

from . import db
from .league import LeagueState

SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}

# Injury designations that should trigger an alert when newly applied.
ALERT_INJURIES = {"Out", "IR", "Doubtful", "PUP", "Sus", "NA", "Questionable"}


@dataclass
class Change:
    category: str
    severity: str
    headline: str
    detail: str = ""
    affects_me: bool = False
    dedupe_key: str = ""


def _roster_map(state: LeagueState) -> dict[str, list[str]]:
    return {str(rid): sorted(t.players) for rid, t in state.teams.items()}


def _injury_map(state: LeagueState, pids) -> dict[str, str]:
    out = {}
    for pid in pids:
        p = state.players.get(pid)
        if p:
            out[pid] = p.injury_status or p.status or ""
    return out


def _depth_map(state: LeagueState, pids) -> dict[str, int | None]:
    out = {}
    for pid in pids:
        p = state.players.get(pid)
        if p:
            out[pid] = p.depth_chart_order
    return out


def detect(state: LeagueState, con, *, watch_extra: set[str] | None = None
           ) -> list[Change]:
    """Compare current state to the last snapshot and emit changes."""
    lid = state.league_id
    changes: list[Change] = []
    me = state.me
    my_players = set(me.players) if me else set()

    # ---- roster movement across the league ----
    current_rosters = _roster_map(state)
    prev_rosters, prev_at = db.latest_snapshot(con, lid, "rosters")
    if prev_rosters:
        for rid, players in current_rosters.items():
            before = set(prev_rosters.get(rid, []))
            after = set(players)
            team = state.teams.get(int(rid))
            tname = team.label if team else f"Roster {rid}"
            mine = team and team.roster_id == state.my_roster_id
            for pid in after - before:
                p = state.players.get(pid)
                changes.append(Change(
                    "roster", "medium" if not mine else "high",
                    f"{tname} added {p.name if p else pid}",
                    f"{p.label() if p else pid} joined {tname}",
                    affects_me=bool(mine),
                    dedupe_key=f"add:{rid}:{pid}:{int(prev_at or 0)}",
                ))
            for pid in before - after:
                p = state.players.get(pid)
                sev = "high" if p and p.position in {"RB", "WR", "TE", "QB"} else "low"
                changes.append(Change(
                    "roster", sev,
                    f"{tname} dropped {p.name if p else pid}",
                    f"{p.label() if p else pid} is now a free agent",
                    affects_me=bool(mine),
                    dedupe_key=f"drop:{rid}:{pid}:{int(prev_at or 0)}",
                ))
    db.save_snapshot(con, lid, "rosters", current_rosters)

    # ---- injuries / status on rostered + watched players ----
    watch = my_players | (watch_extra or set())
    # Opponent starters matter too -- their injuries create trade openings.
    for t in state.teams.values():
        watch |= set(t.players)

    current_inj = _injury_map(state, watch)
    prev_inj, _ = db.latest_snapshot(con, lid, "injuries")
    if prev_inj:
        for pid, status in current_inj.items():
            before = prev_inj.get(pid, "")
            if status == before:
                continue
            p = state.players.get(pid)
            if not p:
                continue
            mine = pid in my_players
            if status in ALERT_INJURIES:
                sev = "critical" if (mine and status in {"Out", "IR", "Doubtful"}) else \
                      "high" if mine else "medium"
                changes.append(Change(
                    "injury", sev,
                    f"{p.name} is now {status}" + (" (YOUR PLAYER)" if mine else ""),
                    f"{p.label()} changed from '{before or 'healthy'}' to '{status}'",
                    affects_me=mine,
                    dedupe_key=f"inj:{pid}:{status}",
                ))
            elif before in ALERT_INJURIES and not status:
                changes.append(Change(
                    "injury", "high" if mine else "low",
                    f"{p.name} is cleared (was {before})",
                    f"{p.label()} no longer carries an injury designation",
                    affects_me=mine,
                    dedupe_key=f"clear:{pid}:{before}",
                ))
    db.save_snapshot(con, lid, "injuries", current_inj)

    # ---- depth chart movement ----
    current_depth = _depth_map(state, watch)
    prev_depth, _ = db.latest_snapshot(con, lid, "depth")
    if prev_depth:
        for pid, order in current_depth.items():
            before = prev_depth.get(pid)
            if before is None or order is None or before == order:
                continue
            p = state.players.get(pid)
            if not p or p.position not in {"QB", "RB", "WR", "TE"}:
                continue
            direction = "up" if order < before else "down"
            if direction == "up" and order == 1:
                sev = "high"
            elif abs(order - before) >= 2:
                sev = "medium"
            else:
                sev = "low"
            changes.append(Change(
                "depth_chart", sev,
                f"{p.name} moved {direction} the {p.team} depth chart ({before} → {order})",
                f"Now listed #{order} at {p.position} for {p.team}",
                affects_me=pid in my_players,
                dedupe_key=f"depth:{pid}:{before}:{order}",
            ))
    db.save_snapshot(con, lid, "depth", current_depth)

    # ---- league transactions (trades, waiver results) ----
    try:
        txs = state.s.transactions(lid, state.current_week, force=True)
    except Exception:
        txs = []
    for tx in txs or []:
        if tx.get("status") != "complete":
            continue
        ttype = tx.get("type")
        tid = tx.get("transaction_id")
        if ttype == "trade":
            rids = tx.get("roster_ids") or []
            names = [state.teams[r].label for r in rids if r in state.teams]
            adds = tx.get("adds") or {}
            moved = ", ".join(
                state.players.get(pid).name for pid in adds
                if state.players.get(pid)
            )
            changes.append(Change(
                "trade", "high",
                f"Trade completed: {' ↔ '.join(names)}",
                f"Players moved: {moved}",
                affects_me=state.my_roster_id in rids,
                dedupe_key=f"tx:{tid}",
            ))
        elif ttype in {"waiver", "free_agent"} and tx.get("adds"):
            rids = tx.get("roster_ids") or []
            tname = state.teams[rids[0]].label if rids and rids[0] in state.teams else "?"
            bid = (tx.get("settings") or {}).get("waiver_bid")
            for pid in (tx.get("adds") or {}):
                p = state.players.get(pid)
                cost = f" for ${bid}" if bid else ""
                changes.append(Change(
                    "waiver", "low",
                    f"{tname} claimed {p.name if p else pid}{cost}",
                    f"{ttype} transaction",
                    affects_me=state.my_roster_id in rids,
                    dedupe_key=f"tx:{tid}:{pid}",
                ))

    # ---- trending spikes on unowned players ----
    # Only the genuine league-wide runs, and only a handful: a wall of
    # "player X is trending" entries buries the changes that matter.
    owned = state.owned_ids()
    startable = {"QB", "RB", "WR", "TE"}
    trend_hits = 0
    for tr in state.s.trending("add", hours=24, limit=25):
        if trend_hits >= 3:
            break
        pid = str(tr["player_id"])
        count = int(tr["count"])
        if pid in owned or count < 75_000:
            continue
        p = state.players.get(pid)
        if not p or p.position not in startable or not p.team:
            continue
        trend_hits += 1
        changes.append(Change(
            "trending", "medium",
            f"{p.name} is being added league-wide ({count:,} adds/24h)",
            f"{p.label()} is still a free agent in your league",
            affects_me=False,
            dedupe_key=f"trend:{pid}:{count // 100_000}",
        ))

    # Persist, dropping anything already reported.
    fresh: list[Change] = []
    for c in changes:
        if db.record_change(con, lid, c.category, c.severity, c.headline,
                            c.detail, c.affects_me, c.dedupe_key):
            fresh.append(c)

    fresh.sort(key=lambda c: (SEVERITY_ORDER.get(c.severity, 9), not c.affects_me))
    return fresh
