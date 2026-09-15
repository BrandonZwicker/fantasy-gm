# Fantasy GM

**[Try it out](https://brandonzwicker.github.io/fantasy-gm/)**

I play in a Sleeper league and don't really have enough time to follow football,
so I built something which reads the league for me and tells me what to do.
Start this guy, claim that one, send this trade.

Runs entirely in the browser. No backend, no build step, no API key.

## Why it's not just another ranker

Most fantasy tools rank players on standard PPR. My league isn't standard PPR
and yours probably isn't either.

Sleeper hands back the raw projected stats rather than a single point total, so
every player gets re-scored on the settings your league actually uses. Take the
same projections from a 1-QB league to superflex and QB replacement level drops
from 265 points to 238, which reprices every quarterback on the board.

## How it decides

The lineup is solved exactly, with a DP over roster slots. Filling the best
player into each slot in turn gets it wrong whenever flex positions overlap.

Waivers rank by points added to your starting lineup rather than by projection,
because a WR4 who never cracks your lineup is worth nothing.

Trades only show up when both rosters improve. Each one comes with a data card
and a list of key points you can turn into your own message.

## Knowing when the number isn't evidence

This is the part I spent the most time on. I checked ~3,700 player-weeks of 2025
projections against what actually happened, and weekly projections miss by about
6.8 points of standard deviation. The gap between two players therefore carries
an SD near 9.6, which means a 1-point edge is right only 54% of the time.

So there's a floor. Over 2.5 points is a real edge and gets recommended. Under
0.75 the two players are the same player and nothing gets said. In between the
projection can't settle it, so it looks at what the projection hasn't absorbed
yet, which is mostly injury news and what everyone else is doing with the guy.
When 84,000 managers drop someone inside 24 hours while his projection still
reads 12, the crowd has reacted to something.

## Injuries

A Questionable tag covers everything from full practice to ACL surgery, so the
tag on its own can't decide a lineup. ESPN publishes injury notes and allows
cross-origin reads, so the browser reads practice participation out of them to
work out whether someone actually suits up.

Healthy players show exactly what Sleeper shows. That one matters, since quietly
shading a number people check against the app is how you stop trusting the whole
thing.

## Checking the math

Tests run against Sleeper's own published numbers rather than against
themselves. Applying a real league's 43-key scoring dictionary to actual stats
reproduces their figure for 100% of QB, RB and TE rows and 99.8% of WR. The
lineup solver matches exhaustive search 300 times out of 300.

That turned up real bugs. Sleeper's season endpoint returns `fgm: null` for
kickers, valuing one at 46 points against a true 111. Their projected points
also aren't the sum of their own projected components, which quietly understates
quarterbacks and kickers.

## Limits

Sleeper has no write API, so this tells you what to do and you tap it in
yourself.

Sleeper only. Yahoo sends no CORS headers and its login needs a private key, so
it would take a server-side proxy.

No server also means no push notifications. It builds a calendar file with
alarms before waivers and kickoff instead, and there's a GitHub Action which
runs the Python version on a schedule if you want proper alerts.

## Layout

```
docs/     the deployed site, plain ES modules, no framework
gm/       Python version, same engine plus scheduled monitoring
tests/    validation, and an end to end test on a synthetic league
```

## Running it

```bash
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python cli.py link <sleeper_username>
./.venv/bin/python cli.py report
./.venv/bin/python tests/test_validation.py
```

The example league on the site is made up. Invented managers, real players, live
projections. Nobody's actual league is on there.
