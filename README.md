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

**Injury news, not just the tag.** "Questionable" covers everything from "full
practice, expected to play" to "ACL surgery", so the tag alone can't decide a
lineup. ESPN publishes a per-team injury report with a narrative note and allows
cross-origin reads, so the browser pulls it directly and reads practice
participation out of it — full practice, limited, DNP, ruled out — to estimate
the odds a player suits up. ESPN's own designation stays authoritative and the
narrative only refines the uncertain cases; letting the text override the status
benched genuinely active players, because the long-form notes recount history.

Numbers you can check against the app are never quietly altered: a healthy
player shows exactly what Sleeper shows, and anyone in doubt shows both figures
plus the odds and the source quote.

**When the decision actually expires.** A swap closes at the *earlier* of the
two players' kickoffs — whoever plays first locks first. "Before Sunday kickoff"
is useless when one of them plays Thursday night. Each start/sit says when the
window shuts and when to take a last look, 90 minutes before, when inactives
are published.

**Risk setting, based on measured error.** I checked 2025 projections against
what actually happened: weekly projections miss by about 6.8 points (standard
deviation) for skill players, so the gap between two players has an SD near 9.6.
That means a 1-point edge is right only **54%** of the time. 2.5 points gets you
to 60%, 5 points to 70%.

So a small edge isn't a free win, it's a coin flip. There's a Cautious /
Balanced / Aggressive toggle setting how big an edge has to be before something
is recommended, and start/sit moves show the actual odds they're right. The
floors are higher for waivers and trades than for start/sit, because those moves
also cost an irreversible drop and finite FAAB or priority — a start/sit is free
and reversible until kickoff. Filtered moves are still listed underneath,
collapsed. Byes and injured starters are never filtered; those are certainties,
not edges.

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
- Don't invent an injury discount and silently change a number people check

## Checking the math

`tests/test_validation.py` tests against Sleeper's own numbers, not against
itself.

Sleeper publishes per-player points next to the raw stats. Applying a real
league's 43-key scoring dictionary to actual stats reproduces their figure for
**100% of QB, RB and TE rows and 99.8% of WR** — mean error 0.004. The lineup
solver is checked against exhaustive search: **300/300 identical**.

That process turned up three real bugs. Sleeper's season endpoint returns
`fgm: null` for kickers, valuing one at 46 points against a true 111. Their
*projected* points aren't the sum of their own projected components. And when I
adopted their projection to fix that, measuring against actual results showed it
**helped kickers but hurt quarterbacks** — their QB number runs about 2.2 points
hot, pushing QB error from 7.53 RMSE to 8.00. So it's applied to kickers only,
where it cuts error from 4.84 to 4.70.

## Limits

Sleeper has no write API. Nothing here can submit a claim or set a lineup, so it
tells you what to do and you tap it in.

Sleeper only. Yahoo sends no CORS headers and its login needs a private key, so
it would need a server-side proxy.

The hosted version has no server, so it only checks for changes while the page
is open, and it can't email or push you anything. Two ways around that:

- **Calendar reminders** — the site generates an `.ics` with an alarm before
  every waiver run and kickoff, timed to your league's settings. Pick which
  events and how far ahead. No account, no backend.
- **Scheduled monitoring** — `.github/workflows/monitor.yml` runs the Python
  engine on a cron schedule, opens a GitHub issue when something needs doing
  (which emails you), and can push to your phone via ntfy.sh. Change the cron
  lines to change the frequency.

## Layout

```
docs/     the site that's deployed (plain ES modules, no framework)
gm/       Python version — same engine, plus scheduled monitoring
          (uses the injury designation only; live news is browser-side)
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
