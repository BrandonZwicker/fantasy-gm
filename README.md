# Fantasy GM

**[Live demo →](https://brandonzwicker.github.io/fantasy-gm/)**

Reads a Sleeper fantasy football league end to end and recommends the exact
roster moves to make — start/sit changes, waiver claims with bid sizing, and
trades — all scored under *that league's own settings* rather than generic
rankings.

The deployed version runs entirely in the browser. There is no backend, no
build step and no API key: it calls Sleeper's public API directly, re-scores
every projection under your league's scoring dictionary, and solves the
optimisation client-side.

---

## Why league-specific scoring matters

Most fantasy tools rank players by standard PPR and call it a day. Sleeper's
projections endpoint returns the **raw stat components** — `rush_yd`, `rec`,
`rec_td`, `pass_int` and forty others — not just a points total. Re-scoring
those components with the league's own `scoring_settings` means a TE-premium,
superflex or half-PPR league gets genuinely different advice.

The effect is not cosmetic. Moving the same projections from a 1-QB to a
superflex league drops QB replacement level from 265 to 238 points, which
reprices every quarterback on the board.

## How the recommendations are built

**Optimal lineup — exact, not greedy.** Filling the best player into each slot
in turn gives the wrong answer when flex eligibility isn't nested (`REC_FLEX`
is WR/TE, `WRRB_FLEX` is RB/WR — neither contains the other). The assignment is
solved exactly with a DP over a bitmask of filled slots.

**Waivers ranked by marginal lineup value.** A free agent is scored by what he
adds to your *starting* lineup, not by his projection. A WR4 who never cracks
your lineup is worth zero no matter how good his ranking looks.

**Recommendations are de-conflicted.** Three defenses competing for the same
bench spot are one move with two fallbacks, not three moves. Moves are chosen
greedily: the best claim is applied to the roster, then everything is re-scored
against the result. A candidate that keeps its value is a separate move; one
whose value collapses was after the same job and becomes an alternative.

**Trades require mutual gain.** Both rosters are re-optimised for every
candidate swap, and only deals that improve *both* lineups survive. Offers are
then filtered by perceived value — a deal that is optimal for both teams still
gets rejected if it looks lopsided, so insulting offers are never shown.

**Everything is ranked on one scale:** points at stake per remaining week,
multiplied by how soon the chance to act disappears. A lineup change locks at
kickoff and is weighted hardest; a waiver claim locks at the next waiver run; a
trade has weeks of runway and is discounted by how likely the partner is to
accept.

**Every move explains itself** behind a "Why this move?" disclosure — what the
player is worth under your scoring, which slot he fills and who he displaces,
why the suggested drop is safe, what the claim costs, and what could go wrong.

## Guardrails that took real debugging

Several of these were bugs the naive version shipped happily:

- **Drops never include a current starter.** Rest-of-season cost reads 0.0 for a
  player who is nonetheless in this week's lineup, because someone absorbs the
  role later in the year. Recommending that player as a "safe drop" would cost
  you the game.
- **A claim can never cut a higher-value asset.** Greedy sequencing will cheerfully
  drop a top-tier TE to stream a defense once a replacement is claimed — the
  lineup math says it's free, but a real asset is destroyed.
- **Start/sit pairs by slot, not by index.** Zipping the entering and leaving
  lists positionally produces advice like "start this QB over that tight end".
- **Pure slot shuffles are suppressed.** Moving an RB between the RB and FLEX
  slots never changes your score; suggesting it is noise, not advice.

## Architecture

```
docs/            the deployed static site (GitHub Pages)
  engine.js      Sleeper client, league rules, scoring, lineup DP, VOR
  advice.js      waivers, trades, change detection
  report.js      orchestration, ranking, generated reasoning
  app.js         UI
gm/              Python reference implementation
tests/           end-to-end tests against a synthetic league
```

The Python package under `gm/` is the reference implementation the engine was
developed and validated against, and it still runs as a local server with a
CLI. It additionally supports **scheduled background monitoring**, which the
static build cannot do — with no server, change detection only runs when the
page is open.

The browser build needs no player database: Sleeper embeds each player's
position, team, opponent and injury status in the projections payload, so the
14.6 MB player dump is never downloaded.

## Running the Python version locally

```bash
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python cli.py link <your_sleeper_username>
./.venv/bin/python cli.py report        # recommendations in the terminal
./.venv/bin/python cli.py serve         # local web dashboard
./.venv/bin/python cli.py watch         # poll for changes
./.venv/bin/python tests/test_pipeline.py
```

Tests run against a synthetic 12-team league built from real player data, so
the full pipeline is exercised without touching anyone's private league.

## Notes

Sleeper has no public write API, so nothing here can submit a waiver claim, set
a lineup or send a trade. It tells you exactly what to do; you tap it into the
app. Everything up to the click is automated.

The example league shown by default anonymises other managers to "Team N" —
their Sleeper handles aren't mine to publish.
