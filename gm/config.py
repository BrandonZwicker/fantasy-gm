"""Local config: which league and which team is yours."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parent.parent / "data" / "config.json"


@dataclass
class Config:
    username: str = ""
    user_id: str = ""
    league_id: str = ""
    league_name: str = ""
    season: str = ""

    @classmethod
    def load(cls) -> "Config":
        if CONFIG_PATH.exists():
            return cls(**json.loads(CONFIG_PATH.read_text()))
        return cls()

    def save(self) -> None:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps(asdict(self), indent=2))

    @property
    def linked(self) -> bool:
        return bool(self.league_id and self.user_id)
