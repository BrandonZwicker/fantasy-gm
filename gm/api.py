"""FastAPI backend.

Stateless and multi-tenant: every request names the league and the user, so a
single running instance serves anyone who enters their own Sleeper username.
The saved config file is only a convenience default for the CLI.
"""
from __future__ import annotations

import asyncio
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .config import Config
from .players import PlayerIndex
from .recommend import build_report
from .sleeper import Sleeper

WEB = Path(__file__).resolve().parent.parent / "web"

app = FastAPI(title="Fantasy GM")

_cache: dict[str, tuple[float, dict]] = {}
_CACHE_TTL = 180
_MAX_CACHE = 64
_lock = asyncio.Lock()


def _resolve_user(username: str) -> dict:
    u = Sleeper().user(username.strip())
    if not u:
        raise HTTPException(404, f"No Sleeper user named '{username}'")
    return u


def _prune_cache() -> None:
    if len(_cache) <= _MAX_CACHE:
        return
    for k, _ in sorted(_cache.items(), key=lambda kv: kv[1][0])[:len(_cache) - _MAX_CACHE]:
        _cache.pop(k, None)


def _report_dict(league_id: str, user_id: str, force: bool, trades: bool) -> dict:
    key = f"{league_id}:{user_id}:{trades}"
    hit = _cache.get(key)
    if hit and not force and (time.time() - hit[0]) < _CACHE_TTL:
        return hit[1]

    r = build_report(league_id, user_id, force=force, do_trades=trades)
    d = r.to_dict()

    # Attach display names so the frontend never needs the 5MB player dump.
    pi = PlayerIndex(Sleeper())
    ids: set[str] = set(r.current_starters)
    if r.lineup:
        ids |= {s.player_id for s in r.lineup.slots if s.player_id}
        ids |= {p for p, _ in r.lineup.bench}
    for a in r.actions:
        for k in ("player_id", "bench", "drop_id"):
            if a.payload.get(k):
                ids.add(a.payload[k])
    for t in r.trades:
        ids |= set(t.send) | set(t.receive)
    for dc in r.drops:
        ids.add(dc.player_id)

    names = {}
    for pid in ids:
        p = pi.get(pid)
        if p:
            names[pid] = {"name": p.name, "position": p.position,
                          "team": p.team, "injury": p.injury_note}
    d["player_names"] = names

    _cache[key] = (time.time(), d)
    _prune_cache()
    return d


@app.get("/api/leagues")
def leagues(username: str, season: str | None = None):
    """Every league this username plays in, for the league picker."""
    s = Sleeper()
    u = _resolve_user(username)
    season = season or s.state()["season"]
    lgs = s.user_leagues(u["user_id"], season) or []
    return {
        "user_id": u["user_id"],
        "username": username,
        "season": season,
        "avatar": u.get("avatar"),
        "leagues": [
            {"league_id": l["league_id"], "name": l["name"],
             "teams": l["total_rosters"], "status": l.get("status", "")}
            for l in lgs
        ],
    }


@app.get("/api/league_info")
def league_info(league_id: str):
    """Basic league identity — used when someone pastes a league ID directly."""
    lg = Sleeper().league(league_id)
    if not lg:
        raise HTTPException(404, "League not found")
    return {"league_id": league_id, "name": lg["name"],
            "season": str(lg["season"]), "teams": lg["total_rosters"]}


@app.get("/api/members")
def members(league_id: str):
    """Who is in this league — lets someone pick their team by name."""
    s = Sleeper()
    lg = s.league(league_id)
    if not lg:
        raise HTTPException(404, "League not found")
    users = s.league_users(league_id) or []
    rosters = {r.get("owner_id"): r for r in (s.rosters(league_id) or [])}
    out = []
    for u in users:
        ro = rosters.get(u["user_id"]) or {}
        out.append({
            "user_id": u["user_id"],
            "display_name": u.get("display_name", ""),
            "team_name": (u.get("metadata") or {}).get("team_name", ""),
            "roster_id": ro.get("roster_id"),
        })
    out.sort(key=lambda m: (m["roster_id"] is None, m["roster_id"] or 0))
    return {"league_id": league_id, "name": lg["name"], "members": out}


@app.get("/api/report")
async def report(league_id: str, user_id: str | None = None,
                 username: str | None = None, force: bool = False,
                 trades: bool = True):
    if not user_id:
        if not username:
            raise HTTPException(400, "Provide user_id or username")
        user_id = _resolve_user(username)["user_id"]
    async with _lock:
        try:
            data = await asyncio.to_thread(_report_dict, league_id, user_id,
                                           force, trades)
        except ValueError as e:
            raise HTTPException(404, str(e)) from e
    return JSONResponse(data)


@app.get("/api/changes")
def changes(league_id: str, limit: int = 60):
    con = db.connect()
    try:
        return {"changes": db.recent_changes(con, league_id, limit)}
    finally:
        con.close()


@app.get("/api/default")
def default():
    """The CLI-linked league, offered as a one-click default. May be empty."""
    cfg = Config.load()
    if not cfg.linked:
        return {"linked": False}
    return {"linked": True, "username": cfg.username, "user_id": cfg.user_id,
            "league_id": cfg.league_id, "league_name": cfg.league_name}


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


if WEB.exists():
    app.mount("/static", StaticFiles(directory=WEB), name="static")
