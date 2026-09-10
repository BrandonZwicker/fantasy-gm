# Fantasy GM

**[Try it out](https://brandonzwicker.github.io/fantasy-gm/)**

I play in a Sleeper league and don't really watch football. So I built something
that reads the league for me and says exactly what to do — who to start, who to
claim, which trades to offer.

Runs entirely in the browser. No backend, no build step, no API key.

## The idea

Most fantasy tools rank players on standard PPR. My league isn't standard PPR,
and yours probably isn't either.

Sleeper's API hands back the raw projected stats — rushing yards, receptions,
touchdowns — not just a point total. So I re-score every player using your
league's actual scoring settings. A TE-premium league gets genuinely different
advice than a superflex one, because the underlying numbers are different.

Same projections, moved from a 1-QB league to superflex, drop QB replacement
level from 265 points to 238. That repricing changes every quarterback on the
board.

## How it decides

**Lineup.** Solves for the best legal lineup exactly, with a DP over roster
slots. Filling the best player into each slot in turn gets it wrong when flex
positions overlap without nesting.

**Waivers.** Ranks free agents by points added to your *starting* lineup, not by
projection. A WR4 who never cracks your lineup is worth nothing. Bids are sized
against your remaining FAAB and how many other managers are adding the guy; in a
priority league it shows your waiver position instead.

**Trades.** Re-optimizes both rosters and only suggests deals that improve both
teams. Offers that would look insulting get filtered out rather than shown.

**Priority.** Everything lands on one scale: points at stake times how soon you
lose the chance to act. Lineup changes lock at kickoff, so they outrank trades
with weeks of runway.

**Risk setting.** A move that gains 0.8 projected points isn't worth making —
weekly projections carry a few points of error, so an edge that small is as
likely to cost you as gain you. There's a Cautious / Balanced / Aggressive
toggle that sets how big an edge has to be before something gets recommended.
Balanced is the default. Whatever gets filtered out is still listed underneath,
collapsed, so you can see what you're skipping. Bye weeks and injured starters
are never filtered — those are certainties, not edges.

Mutually exclusive moves collapse into one recommendation with fallbacks — three
defenses competing for the same bench spot is one move, not three. Every
suggestion explains its reasoning if you open it.

## Things that had to be right

Most of these shipped broken first and got caught:

- Don't suggest dropping someone who's in this week's lineup
- Don't cut a good TE to stream a defense because the math says it's free
- Don't offer two trades that together send away both quarterbacks
- Don't say "start this QB over that tight end"
- Don't suggest shuffling a player between RB and FLEX for zero points
- Don't push a move whose edge is smaller than the error on the projection

## Checking the math

`tests/test_validation.py` tests against Sleeper's own numbers, not against
itself.

Sleeper publishes per-player points next to the raw stats. Applying a real
league's 43-key scoring dictionary to actual stats reproduces their figure for
**100% of QB, RB and TE rows and 99.8% of WR** — mean error 0.004. The lineup
solver is checked against exhaustive search: **300/300 identical**.

That process turned up two real bugs. Sleeper's season endpoint returns
`fgm: null` for kickers, valuing one at 46 points against a true 111. And their
*projected* points aren't the sum of their own projected components — QBs came
out 2.24 low, kickers 1.52 low — so projections now add that difference back,
which still leaves league-specific scoring intact.

## Limits

Sleeper has no write API. Nothing here can submit a claim or set a lineup, so it
tells you what to do and you tap it in.

Sleeper only. Yahoo sends no CORS headers and its login needs a private key, so
it would need a server-side proxy.

The hosted version has no server, so it only checks for changes while the page
is open. The Python version underneath can poll on a schedule.

## Layout

```
docs/     the site that's deployed (plain ES modules, no framework)
gm/       Python version — same engine, plus scheduled monitoring
tests/    validation and an end-to-end test on a synthetic league
```

## Running it

```bash
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python cli.py link <sleeper_username>
./.venv/bin/python cli.py report     # recommendations in the terminal
./.venv/bin/python cli.py serve      # local dashboard
./.venv/bin/python tests/test_validation.py
```

The example league on the site is fake — invented managers, real players and
live projections. Nobody's actual league is on there.
