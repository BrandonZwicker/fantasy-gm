"""SQLite store for snapshots, detected changes and the action log."""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "gm.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    taken_at REAL NOT NULL,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap ON snapshots(league_id, kind, taken_at DESC);

CREATE TABLE IF NOT EXISTS changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id TEXT NOT NULL,
    detected_at REAL NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    headline TEXT NOT NULL,
    detail TEXT,
    affects_me INTEGER DEFAULT 0,
    dedupe_key TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_change_dedupe
    ON changes(league_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_change_time ON changes(league_id, detected_at DESC);

CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id TEXT NOT NULL,
    created_at REAL NOT NULL,
    week INTEGER,
    kind TEXT NOT NULL,
    priority INTEGER DEFAULT 5,
    headline TEXT NOT NULL,
    detail TEXT,
    payload TEXT,
    status TEXT DEFAULT 'open',
    dedupe_key TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_action_dedupe
    ON actions(league_id, dedupe_key);
"""


def connect(path: Path | str = DB_PATH) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def save_snapshot(con, league_id: str, kind: str, payload) -> None:
    con.execute(
        "INSERT INTO snapshots(league_id, kind, taken_at, payload) VALUES (?,?,?,?)",
        (league_id, kind, time.time(), json.dumps(payload)),
    )
    con.commit()


def latest_snapshot(con, league_id: str, kind: str, skip: int = 0):
    row = con.execute(
        "SELECT payload, taken_at FROM snapshots WHERE league_id=? AND kind=?"
        " ORDER BY taken_at DESC LIMIT 1 OFFSET ?",
        (league_id, kind, skip),
    ).fetchone()
    return (json.loads(row["payload"]), row["taken_at"]) if row else (None, None)


def record_change(con, league_id: str, category: str, severity: str,
                  headline: str, detail: str = "", affects_me: bool = False,
                  dedupe_key: str | None = None) -> bool:
    try:
        con.execute(
            "INSERT INTO changes(league_id, detected_at, category, severity,"
            " headline, detail, affects_me, dedupe_key) VALUES (?,?,?,?,?,?,?,?)",
            (league_id, time.time(), category, severity, headline, detail,
             int(affects_me), dedupe_key or headline),
        )
        con.commit()
        return True
    except sqlite3.IntegrityError:
        return False  # already recorded


def recent_changes(con, league_id: str, limit: int = 50) -> list[dict]:
    rows = con.execute(
        "SELECT * FROM changes WHERE league_id=? ORDER BY detected_at DESC LIMIT ?",
        (league_id, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def prune(con, days: int = 45) -> None:
    cutoff = time.time() - days * 86400
    con.execute("DELETE FROM snapshots WHERE taken_at < ?", (cutoff,))
    con.execute("DELETE FROM changes WHERE detected_at < ?", (cutoff,))
    con.commit()
