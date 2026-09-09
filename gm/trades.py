"""Trade finder.

A trade only happens when both sides improve. That occurs when rosters are
positionally imbalanced: your surplus at one position is their hole, and vice
versa. We evaluate candidate swaps by re-optimising BOTH lineups and keeping
only the ones with mutual gain.
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field

from .league import LeagueState, Team
from .lineup import lineup_value
from .value import ReplacementLevels, vor


@dataclass
class TradeIdea:
    partner_roster_id: int
    partner_name: str
    send: list[str] = field(default_factory=list)
    receive: list[str] = field(default_factory=list)
    send_names: list[str] = field(default_factory=list)
    receive_names: list[str] = field(default_factory=list)
    my_gain: float = 0.0
    their_gain: float = 0.0
    fairness: float = 0.0        # 0..1, higher = more balanced
    value_ratio: float = 0.0     # VOR you send / VOR you receive
    acceptance: str = "unknown"  # likely | possible | long shot | unlikely
    rationale: str = ""
    # Offers built on the same players. Only one of these can be executed.
    alternatives: list["TradeIdea"] = field(default_factory=list)

    @property
    def summary(self) -> str:
        return (f"Send {', '.join(self.send_names)} → "
                f"Get {', '.join(self.receive_names)}")


# Managers trade on perceived player value, not on your lineup math. A deal
# that is optimal for both lineups still gets rejected if it looks lopsided,
# so we score how sendable each offer actually is.
ACCEPTANCE_BANDS = [
    (0.90, "likely"),
    (0.72, "possible"),
    (0.55, "long shot"),
    (0.0, "unlikely"),
]


def _acceptance(ratio: float) -> str:
    for threshold, label in ACCEPTANCE_BANDS:
        if ratio >= threshold:
            return label
    return "unlikely"


def _positional_profile(state: LeagueState, team: Team,
                        ros: dict[str, float]) -> dict[str, list[float]]:
    prof: dict[str, list[float]] = {}
    for pid in team.active_players():
        p = state.players.get(pid)
        if p:
            prof.setdefault(p.position, []).append(ros.get(pid, 0.0))
    for v in prof.values():
        v.sort(reverse=True)
    return prof


def _team_value(state: LeagueState, team_pts: dict[str, float]) -> float:
    return lineup_value(state.rules, team_pts, state.positions_map(team_pts))


def _swap(pts: dict[str, float], out_ids, in_ids, source: dict[str, float]) -> dict[str, float]:
    new = dict(pts)
    for pid in out_ids:
        new.pop(pid, None)
    for pid in in_ids:
        new[pid] = source.get(pid, 0.0)
    return new


def trade_chips(state: LeagueState, ros: dict[str, float],
                levels: ReplacementLevels, limit: int = 3) -> list[tuple[str, float]]:
    """Your most tradeable assets: market value your lineup barely uses.

    A chip needs both properties. Positive value-over-replacement means another
    manager actually wants him; a low lineup cost means your own team hardly
    notices he is gone because someone behind him absorbs the role. Ranking by
    VOR alone would nominate your best players, and ranking by low cost alone
    would nominate players nobody wants.
    """
    me = state.me
    if not me:
        return []
    my_pts = state.roster_projection(me, ros)
    positions = state.positions_map(my_pts)
    base = lineup_value(state.rules, my_pts, positions)
    vors = vor(ros, state.players, levels)

    # A player is cheaply replaceable when losing him costs well under what
    # the market thinks he is worth.
    REPLACEABLE = 0.35

    out = []
    for pid in my_pts:
        value = vors.get(pid, 0.0)
        if value <= 0:
            continue  # nobody is trading for a below-replacement player
        cost = base - lineup_value(state.rules, my_pts, positions, exclude={pid})
        if cost > REPLACEABLE * value:
            continue  # you would feel this one -- not a chip
        out.append((pid, round(value, 2)))
    out.sort(key=lambda kv: -kv[1])
    return out[:limit]


def find_trades(state: LeagueState, ros: dict[str, float],
                levels: ReplacementLevels, *,
                limit: int = 8, max_send: int = 2,
                min_my_gain: float = 3.0,
                min_their_gain: float = 1.0) -> list[TradeIdea]:
    me = state.me
    if not me:
        return []

    my_pts = state.roster_projection(me, ros)
    my_base = _team_value(state, my_pts)
    vors = vor(ros, state.players, levels)

    # My tradeable pieces: surplus depth, not my irreplaceable starters.
    my_ranked = sorted(my_pts.items(), key=lambda kv: -kv[1])
    my_candidates = [pid for pid, _ in my_ranked[1:]]  # keep the single best player
    my_candidates = my_candidates[:12]

    ideas: list[TradeIdea] = []

    for opp in state.opponents():
        their_pts = state.roster_projection(opp, ros)
        if not their_pts:
            continue
        their_base = _team_value(state, their_pts)

        their_ranked = sorted(their_pts.items(), key=lambda kv: -kv[1])
        their_targets = [pid for pid, _ in their_ranked[:12]]

        my_prof = _positional_profile(state, me, ros)
        their_prof = _positional_profile(state, opp, ros)

        combos: list[tuple[tuple[str, ...], tuple[str, ...]]] = []
        for get in their_targets:
            for n in range(1, max_send + 1):
                for send in itertools.combinations(my_candidates, n):
                    combos.append((send, (get,)))

        seen: set[tuple] = set()
        for send, get in combos:
            key = (tuple(sorted(send)), tuple(sorted(get)))
            if key in seen:
                continue
            seen.add(key)

            mine_after = _swap(my_pts, send, get, ros)
            my_val = _team_value(state, mine_after)
            my_gain = round(my_val - my_base, 2)
            if my_gain < min_my_gain:
                continue

            theirs_after = _swap(their_pts, get, send, ros)
            their_val = _team_value(state, theirs_after)
            their_gain = round(their_val - their_base, 2)
            if their_gain < min_their_gain:
                continue

            # Roster-size legality: a 2-for-1 leaves them a man short.
            if len(send) != len(get):
                if len(their_pts) - len(get) + len(send) > state.rules.roster_size:
                    continue

            # Perceived-value check: what you give up vs what you ask for.
            vor_send = sum(max(0.0, vors.get(p, 0.0)) for p in send)
            vor_get = sum(max(0.0, vors.get(p, 0.0)) for p in get)
            ratio = round(vor_send / vor_get, 2) if vor_get > 0 else 2.0
            accept = _acceptance(ratio)
            if accept == "unlikely":
                continue  # don't waste your credibility on insulting offers

            total = my_gain + their_gain
            fairness = round(1 - abs(my_gain - their_gain) / total, 2) if total else 0.0

            send_pos = {state.players.get(p).position for p in send if state.players.get(p)}
            get_pos = {state.players.get(p).position for p in get if state.players.get(p)}
            why = []
            for gp in get_pos:
                depth = len(their_prof.get(gp, []))
                why.append(f"they carry {depth} {gp}s and can absorb the loss")
            for sp in send_pos:
                depth = len(my_prof.get(sp, []))
                if depth >= 3:
                    why.append(f"you have {depth} {sp}s — surplus you can't start")
            why.append(f"your lineup +{my_gain:.1f}, theirs +{their_gain:.1f} rest-of-season")
            why.append(f"value you send vs receive: {ratio:.2f}x ({accept} to be accepted)")
            if ratio > 2.0:
                why.append("you give up real depth here — fine if you need the "
                           "starting upgrade, risky if injuries hit")

            ideas.append(TradeIdea(
                partner_roster_id=opp.roster_id,
                partner_name=opp.label,
                send=list(send), receive=list(get),
                send_names=[state.players.get(p).name for p in send if state.players.get(p)],
                receive_names=[state.players.get(p).name for p in get if state.players.get(p)],
                my_gain=my_gain, their_gain=their_gain, fairness=fairness,
                value_ratio=ratio, acceptance=accept,
                rationale="; ".join(dict.fromkeys(why)),
            ))

    # Keep the best idea per partner first, then fill by overall gain.
    accept_weight = {"likely": 1.0, "possible": 0.75, "long shot": 0.45, "unlikely": 0.0}
    ideas.sort(key=lambda t: -(t.my_gain * accept_weight.get(t.acceptance, 0.3)
                               + t.their_gain * 0.03))

    # You can only send a given player once, so every offer built on the same
    # outgoing piece is an alternative to the best one, not a separate move.
    by_send: dict[tuple, list[TradeIdea]] = {}
    for i in ideas:
        by_send.setdefault(tuple(sorted(i.send)), []).append(i)

    grouped: list[TradeIdea] = []
    for group in by_send.values():
        head = group[0]
        head.alternatives = group[1:4]
        grouped.append(head)
    grouped.sort(key=lambda t: -(t.my_gain * accept_weight.get(t.acceptance, 0.3)
                                 + t.their_gain * 0.03))

    # The shortlist has to be executable as a whole, not just pairwise valid.
    # Two separately sensible offers can send both your quarterbacks and leave
    # you unable to field a lineup, so each is applied to a running roster and
    # rejected if it breaks legality.
    seen_recv: set[str] = set()
    sent_all: set[str] = set()
    sim = dict(my_pts)
    final: list[TradeIdea] = []
    for i in grouped:
        if any(p in seen_recv for p in i.receive):
            continue
        if any(p in sent_all for p in i.send):
            continue
        after = _swap(sim, i.send, i.receive, ros)
        from .lineup import optimize as _optimize
        lu = _optimize(state.rules, after, state.positions_map(after))
        if any(s.player_id is None for s in lu.slots):
            continue  # would leave a starting slot empty
        sim = after
        sent_all |= set(i.send)
        seen_recv |= set(i.receive)
        final.append(i)
        if len(final) >= limit:
            break
    return final
