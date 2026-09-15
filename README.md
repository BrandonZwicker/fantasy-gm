# Fantasy GM

**[Try it out](https://brandonzwicker.github.io/fantasy-gm/)**

I play in a Sleeper league and don't really have enough time to follow football.
So I built something that reads the league for me and says exactly what to do,
which players to start, who to claim, and which trades are worth offering.

It runs entirely in the browser. No backend, no build step, no API key.

## The idea

Most fantasy tools rank players on standard PPR. My league isn't standard PPR,
and yours probably isn't either.

Sleeper's API hands back the raw projected stats, meaning rushing yards,
receptions and touchdowns rather than a single point total. So every player gets
re-scored using the scoring settings your league actually uses, which is what
makes the advice specific to you. Moving the same projections from a 1-QB league
to superflex drops QB replacement level from 265 points to 238, and that
repricing changes every quarterback on the board.

## How it decides

**Lineup.** Solves for the best legal lineup exactly, using a DP over roster
slots. Filling the best player into each slot in turn gets it wrong whenever
flex positions overlap without nesting.

**Waivers.** Ranks free agents by points added to your starting lineup rather
than by projection. A WR4 who never cracks your lineup is worth nothing. Bids
are sized against your remaining FAAB and against how many other managers are
adding the same player, and priority leagues show your waiver position instead.

**Trades.** Re-optimizes both rosters and only suggests deals which improve both
teams. Offers that would look insulting get filtered out rather than shown.

**Trade proposal package.** A trade only happens if the other manager says yes,
and nobody says yes to a wall of numbers about how much it helps you. So every
proposed deal comes with a shareable graphic and a written pitch built from
their side of it, showing which hole it fills for them and what their starting
lineup is worth before and after. It argues honestly, which matters more than it
sounds. An early version claimed a player was "depth you can't get on the field"
when he was actually their starting receiver, which is the sort of line that
gets a proposal ignored and makes you look like you never read their roster. It
now checks whether the piece genuinely sits on their bench, and where it doesn't
it says so outright and argues from depth instead. It also admits the trade
helps you, since only mutual-gain deals get proposed and pretending otherwise
costs you credibility for a whole season.

## Knowing when the number isn't evidence

This is the part I spent the most time on. I compared ~3,700 player-weeks of
2025 projections against what actually happened, and weekly projections miss by
about 6.8 points of standard deviation for skill players. The gap between two
players therefore carries a standard deviation near 9.6, which means a 1-point
edge is right only 54% of the time. 2.5 points gets you to 60%, and 5 points to
70%.

That measurement splits every start or sit decision into three cases. Above 2.5
points the projection is real evidence and the move is recommended outright.
Below 0.75 points the two players are the same player as far as the numbers go,
so nothing is said at all. In between the projection cannot settle it, which is
where the interesting case lives.

For those near-ties the app stops pretending the number decides, and looks at
evidence the projection has not absorbed yet. Projections update on a lag, but
roster moves do not. When 84,000 managers drop a player inside 24 hours while
his projection still reads 12 points, the crowd has reacted to something the
projection hasn't, and that gap is information. Injury reports work the same
way. Those near-ties get shown as a judgment call with whatever evidence exists,
and when nothing separates the two players it says so and recommends leaving the
lineup alone.

Beyond the near-ties, the same reasoning drives a separate warning. If the
league is dumping somebody who is currently in your starting lineup, that is
worth two minutes of reading before kickoff, whatever his projection says.

## Injury news, not just the tag

A Questionable tag covers everything from full practice and expected to play,
all the way to ACL surgery, so the tag on its own cannot decide a lineup. ESPN
publishes a per-team injury report with a narrative note and allows cross-origin
reads, so the browser pulls it directly and reads practice participation out of
it to estimate the odds a player suits up.

ESPN's own designation stays authoritative and the narrative only refines the
uncertain cases. Letting the text override the status benched genuinely active
players, because the long-form notes recount history. Numbers you can check
against the app are never quietly altered either. A healthy player shows exactly
what Sleeper shows, and anyone in doubt shows both figures along with the odds
and the source quote.

## When the decision actually expires

A swap closes at the earlier of the two players' kickoffs, since whoever plays
first locks first. "Before Sunday kickoff" is useless when one of them plays
Thursday night. Every start or sit says when its window shuts and when to take a
final look, which is 90 minutes beforehand when inactives are published. A swap
whose window has already closed is not shown at all.

## Things which had to be right

Most of these shipped broken first and got caught:

- Don't suggest dropping someone who is in this week's lineup
- Don't cut a good TE to stream a defense because the math says it is free
- Don't offer two trades which together send away both quarterbacks
- Don't say "start this QB over that tight end"
- Don't invent an injury discount and silently change a number people check
- Don't push a move whose edge is smaller than the error on the projection

## Checking the math

`tests/test_validation.py` tests against Sleeper's own numbers rather than
against itself. Sleeper publishes per-player points next to the raw stats, so
applying a real league's 43-key scoring dictionary to actual stats has to
reproduce their figure. It does, for 100% of QB, RB and TE rows and 99.8% of WR,
at a mean error of 0.004. The lineup solver is checked against exhaustive
search, which it matches 300 times out of 300.

That process turned up three real bugs. Sleeper's season endpoint returns
`fgm: null` for kickers, valuing one at 46 points against a true 111. Their
projected points are not the sum of their own projected components. And when I
adopted their projection to fix that, measuring against actual results showed it
helped kickers but hurt quarterbacks, since their QB number runs about 2.2
points hot. It is applied to kickers only, where it cuts error from 4.84 to 4.70.

## Limits

Sleeper has no write API, so nothing here can submit a claim or set a lineup. It
tells you what to do and you tap it in.

Sleeper only. Yahoo sends no CORS headers and its login needs a private key, so
it would need a server-side proxy.

The hosted version has no server, so it only checks for changes while the page
is open and cannot email or push you anything. Two ways around that. The site
generates an `.ics` with an alarm before every waiver run and kickoff, timed to
your league's settings, and you pick which events and how far ahead.
`.github/workflows/monitor.yml` runs the Python engine on a cron schedule,
opens a GitHub issue when something needs doing, and can push to your phone
through ntfy.sh.

## Layout

```
docs/     the site which is deployed, plain ES modules, no framework
gm/       Python version, same engine plus scheduled monitoring
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

The example league on the site is fake. Invented managers, real players, live
projections. Nobody's actual league is on there.
