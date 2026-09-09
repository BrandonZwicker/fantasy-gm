"""Thin, cached client for the Sleeper public API.

Sleeper's API is read-only and unauthenticated. There is no write endpoint,
so nothing here can submit a waiver claim, set a lineup or send a trade --
we can only read state and recommend actions.

Docs: https://docs.sleeper.com/  (projections/stats endpoints are undocumented)
Rate limit: stay under 1000 calls/minute.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import requests

V1 = "https://api.sleeper.app/v1"
ROOT = "https://api.sleeper.app"

CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# How long a cached response stays fresh, by logical resource.
TTL = {
    "players": 24 * 3600,     # ~5MB dump, changes slowly
    "league": 15 * 60,
    "rosters": 5 * 60,
    "users": 6 * 3600,
    "matchups": 60,
    "transactions": 5 * 60,
    "trending": 30 * 60,
    "projections": 3 * 3600,
    "stats": 30 * 60,
    "state": 15 * 60,
    "default": 10 * 60,
}


class SleeperError(RuntimeError):
    pass


class Sleeper:
    def __init__(self, session: requests.Session | None = None, min_interval: float = 0.05):
        self.s = session or requests.Session()
        self.s.headers.update({"User-Agent": "fantasy-gm/1.0"})
        self._last_call = 0.0
        self._min_interval = min_interval

    # ---------- plumbing ----------

    def _throttle(self) -> None:
        delta = time.time() - self._last_call
        if delta < self._min_interval:
            time.sleep(self._min_interval - delta)
        self._last_call = time.time()

    def _cache_path(self, key: str) -> Path:
        safe = key.replace("/", "_").replace("?", "_").replace("&", "_").replace("=", "-")
        return CACHE_DIR / f"{safe}.json"

    def _get(self, url: str, *, key: str, kind: str = "default", force: bool = False) -> Any:
        path = self._cache_path(key)
        ttl = TTL.get(kind, TTL["default"])
        if not force and path.exists() and (time.time() - path.stat().st_mtime) < ttl:
            try:
                return json.loads(path.read_text())
            except json.JSONDecodeError:
                pass  # corrupt cache, refetch

        self._throttle()
        try:
            r = self.s.get(url, timeout=30)
        except requests.RequestException as e:
            # Network hiccup: fall back to stale cache rather than dying.
            if path.exists():
                return json.loads(path.read_text())
            raise SleeperError(f"GET {url} failed: {e}") from e

        if r.status_code == 404:
            return None
        if r.status_code != 200:
            if path.exists():
                return json.loads(path.read_text())
            raise SleeperError(f"GET {url} -> HTTP {r.status_code}")

        data = r.json()
        path.write_text(json.dumps(data))
        return data

    # ---------- identity ----------

    def state(self, force: bool = False) -> dict:
        return self._get(f"{V1}/state/nfl", key="state_nfl", kind="state", force=force)

    def user(self, username: str) -> dict | None:
        return self._get(f"{V1}/user/{username}", key=f"user_{username}", kind="users")

    def user_leagues(self, user_id: str, season: str) -> list[dict]:
        return self._get(
            f"{V1}/user/{user_id}/leagues/nfl/{season}",
            key=f"userleagues_{user_id}_{season}",
            kind="league",
        ) or []

    # ---------- league ----------

    def league(self, league_id: str, force: bool = False) -> dict:
        return self._get(f"{V1}/league/{league_id}", key=f"league_{league_id}",
                         kind="league", force=force)

    def rosters(self, league_id: str, force: bool = False) -> list[dict]:
        return self._get(f"{V1}/league/{league_id}/rosters", key=f"rosters_{league_id}",
                         kind="rosters", force=force) or []

    def league_users(self, league_id: str, force: bool = False) -> list[dict]:
        return self._get(f"{V1}/league/{league_id}/users", key=f"lusers_{league_id}",
                         kind="users", force=force) or []

    def matchups(self, league_id: str, week: int, force: bool = False) -> list[dict]:
        return self._get(f"{V1}/league/{league_id}/matchups/{week}",
                         key=f"matchups_{league_id}_{week}", kind="matchups", force=force) or []

    def transactions(self, league_id: str, week: int, force: bool = False) -> list[dict]:
        return self._get(f"{V1}/league/{league_id}/transactions/{week}",
                         key=f"tx_{league_id}_{week}", kind="transactions", force=force) or []

    def traded_picks(self, league_id: str) -> list[dict]:
        return self._get(f"{V1}/league/{league_id}/traded_picks",
                         key=f"picks_{league_id}", kind="league") or []

    def drafts(self, league_id: str) -> list[dict]:
        return self._get(f"{V1}/league/{league_id}/drafts",
                         key=f"drafts_{league_id}", kind="league") or []

    # ---------- players ----------

    def players(self, force: bool = False) -> dict[str, dict]:
        """Full NFL player dump (~5MB). Cached for a day."""
        return self._get(f"{V1}/players/nfl", key="players_nfl",
                         kind="players", force=force) or {}

    def trending(self, kind: str = "add", hours: int = 24, limit: int = 50) -> list[dict]:
        return self._get(
            f"{V1}/players/nfl/trending/{kind}?lookback_hours={hours}&limit={limit}",
            key=f"trending_{kind}_{hours}_{limit}", kind="trending",
        ) or []

    # ---------- projections & stats (undocumented) ----------

    def projections(self, season: str, week: int | None = None,
                    season_type: str = "regular", force: bool = False) -> list[dict]:
        """Weekly (week given) or season-long (week omitted) projections.

        Returns raw stat components -- we re-score these under the league's own
        scoring settings rather than trusting Sleeper's canned pts_ppr.
        """
        if week is None:
            url = f"{ROOT}/projections/nfl/{season}?season_type={season_type}"
            key = f"proj_{season}_season"
        else:
            url = f"{ROOT}/projections/nfl/{season}/{week}?season_type={season_type}"
            key = f"proj_{season}_{week}"
        return self._get(url, key=key, kind="projections", force=force) or []

    def stats(self, season: str, week: int | None = None,
              season_type: str = "regular", force: bool = False) -> list[dict]:
        """Actual produced stats, same shape as projections."""
        if week is None:
            url = f"{ROOT}/stats/nfl/{season}?season_type={season_type}"
            key = f"stats_{season}_season"
        else:
            url = f"{ROOT}/stats/nfl/{season}/{week}?season_type={season_type}"
            key = f"stats_{season}_{week}"
        return self._get(url, key=key, kind="stats", force=force) or []
