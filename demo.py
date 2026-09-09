#!/usr/bin/env python
"""Run the dashboard against the synthetic league.

Lets you see the whole interface working before linking a real league.
Real player data and real projections; only the league/rosters are fabricated.
"""
import sys
sys.path.insert(0, ".")

from gm.sleeper import Sleeper
from tests import synthetic

_league, _rosters, _users, _my_uid = synthetic.build(Sleeper(), my_slot=3)
synthetic.patch(Sleeper, _league, _rosters, _users)

from gm.config import Config
import gm.api as api

# Point the app at the synthetic league without touching the saved config.
_demo_cfg = Config(username="demo", user_id=_my_uid, league_id="SYNTH1",
                   league_name=_league["name"], season=synthetic.SEASON)
Config.load = staticmethod(lambda: _demo_cfg)
api.Config = Config

app = api.app

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8077, log_level="warning")
