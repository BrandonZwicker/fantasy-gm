# Fantasy GM

An automated general manager for a Sleeper fantasy football league. It reads your
league's exact settings, re-scores every NFL player under *your* rules, and tells
you the specific roster moves to make.

Built for someone who doesn't watch football.

## What it does

- **Reads your league's real rules** — scoring dictionary, roster slots, waiver
  type and budget, trade deadline, playoff structure. Every recommendation is
  derived from these, not from generic PPR rankings.
- **Optimal lineup** — solves the start/sit assignment exactly (flex slots and
  all), and tells you which swaps gain how many points.
- **Waiver targets** — ranked by points added *to your starting lineup*, with a
  FAAB bid sized against your remaining budget and league-wide competition.
- **Drop candidates** — who you can cut with the least cost.
- **Trade finder** — scans every rival roster for deals that improve both teams,
  and labels how likely each is to actually be accepted.
- **Change monitor** — diffs the league between checks: adds, drops, trades,
  injury designations, depth-chart moves, and league-wide waiver runs.

## The one limitation

**Sleeper has no public write API.** Nothing here can submit a waiver claim, set
a lineup, or send a trade offer on your behalf. This tells you exactly what to do
and when; you tap it into the Sleeper app. Everything up to that click is automated.

## Setup

Start the server and open it — anyone can use it with their own account:

```bash
cd fantasy-gm
./.venv/bin/python cli.py serve
```

Then open http://localhost:8000. It loads the **default league** straight away —
whichever one was set with `cli.py link` (see below).

Anyone else can use it with their own account: **Switch league** in the header
opens the picker, where they enter their Sleeper username and choose a league.
If a league doesn't appear (an older season, or an account they don't own), they
can paste the league ID instead and pick which team is theirs. The picker always
offers a one-click way back to the default.

The server holds one configured default and no per-visitor state. Once someone
picks their own league it lives in their browser (`localStorage`), never on the
server, so several people can use one instance at once without colliding.

### Setting the default league

```bash
./.venv/bin/python cli.py link <your_sleeper_username>
```

This writes `data/config.json` and becomes what the dashboard shows to any
visitor who hasn't picked a league of their own. It is also what `cli.py report`
and `cli.py watch` operate on.

```bash
./.venv/bin/python cli.py report
```

## Usage

```bash
./.venv/bin/python cli.py report          # full recommendations
./.venv/bin/python cli.py report --force  # bypass cache, fresh pull
./.venv/bin/python cli.py watch --every 900   # poll and print changes
./.venv/bin/python cli.py serve           # web dashboard on :8000
./.venv/bin/python demo.py                # synthetic league on :8077
```

The dashboard is the main interface: an action queue at the top, the optimal
lineup, waiver targets with bids, trade ideas, and a change feed.

### Running it continuously

`watch` polls on an interval. To have it run unattended, schedule it — the
useful cadence is hourly during the week, and every 15 minutes on Sunday
mornings before the early kickoffs.

```bash
# crontab -e
0 * * * * cd /path/to/fantasy-gm && ./.venv/bin/python cli.py report --force >> data/gm.log 2>&1
```

## How the recommendations work

**Scoring.** Sleeper exposes projections as raw stat components
(`rush_yd`, `rec`, `rec_td`, …). We apply your league's own scoring dictionary to
those components. A TE-premium or superflex league produces genuinely different
numbers, not the same rankings relabelled.

**Value over replacement.** Raw points rank QBs first in every league. What
matters is the surplus over the freely available alternative at that position,
and replacement level depends on how many of each position your league starts.
A superflex league drops QB replacement level sharply, which reprices every QB.

**Marginal value.** A waiver target is scored by how much he adds to your
*optimal lineup*, not by his projection. A WR4 who never cracks your lineup is
worth zero no matter how good he looks on a ranking page.

**Trade acceptance.** A deal that is optimal for both lineups still gets
rejected if it looks lopsided by name value. Each idea is scored on the value
you send versus receive, and offers that would insult the other manager are
suppressed rather than shown. When nothing qualifies, it says so and names your
most tradeable surplus instead of showing an empty panel.

**Waivers adapt to the league.** FAAB leagues get a bid sized against your
remaining budget and league-wide competition. Priority leagues (rolling or
reverse-standings) get your current priority number instead, because there is
nothing to bid.

**Recommendations are de-conflicted.** Three defenses that all want the same
bench spot are one move with two fallbacks, not three moves. Moves are chosen
greedily: the best claim is applied to the roster, then everything is re-scored
against the result. A candidate that keeps its value is a genuinely separate
move; one whose value collapses was after the same job and is attached to the
winner as an alternative. The same holds for trades built on the same outgoing
player. Greedy sequencing is also capped so a claim can never cut a
higher-value asset than the one being added — otherwise it will happily drop a
top-tier TE to stream a defense once a replacement is in hand.

**Everything is ranked on one scale.** Each suggested move carries the points
at stake and the deadline that applies to it, and is scored as impact per
remaining week multiplied by how soon the chance to act disappears. A lineup
change locks at kickoff and is weighted hardest; a waiver claim locks at the
next waiver run; a trade has weeks of runway and is discounted further by how
likely the partner is to accept. That produces the ordering and the tier label
("Do now" through "Optional") rather than a hand-assigned priority.

**Every move explains itself.** Each recommendation carries a step-by-step
justification — what the player is worth under your scoring, which slot he
fills and who he displaces, why the suggested drop is safe, what the claim
costs, and what could go wrong — shown behind a "Why this move?" disclosure.

**Drops never include a current starter.** Rest-of-season cost can read 0.0 for
a player who is nonetheless in this week's lineup, since someone absorbs the
role later in the year. Those players are flagged and held back.

## Layout

```
gm/sleeper.py      Cached Sleeper API client
gm/scoring.py      League rules + scoring engine
gm/players.py      Player index, injury handling
gm/projections.py  Projections re-scored under your rules; bye detection
gm/lineup.py       Exact lineup optimizer (DP over slot assignments)
gm/value.py        Replacement levels and VOR
gm/league.py       Assembled league state: teams, rosters, free agents
gm/waivers.py      Waiver targets, FAAB bid sizing, drop candidates
gm/trades.py       Mutual-gain trade finder with acceptance modelling
gm/monitor.py      Change detection between polls
gm/recommend.py    Orchestrator -> ranked action queue
gm/api.py          FastAPI backend
web/index.html     Dashboard
tests/             Synthetic league harness + end-to-end test
```

## Testing

`tests/` builds a realistic 12-team league from real players and real
projections, so the whole pipeline can be exercised without touching anyone's
private league.

```bash
./.venv/bin/python tests/test_pipeline.py
```
