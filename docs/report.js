/* Fantasy GM — orchestrator. Turns league state into a ranked action queue.
 * Ported from ../gm/recommend.py.
 */

import {
  LeagueState, SLOT_ELIGIBILITY, Sleeper,
  edgeConfidence, optimize, pronouns, replacementLevels, vor,
} from './engine.js';
import {
  applyMoves, cloneTeam, detectChanges, dropCandidates, findTrades,
  planRosterFix, recommendWaivers, tradeChips,
} from './advice.js';
import { fetchInjuryReport } from './injuries.js';
import { INACTIVES_LEAD_MIN, fetchKickoffs, swapDeadline } from './schedule.js';
import { breakTie, fetchSentiment, sentimentOf } from './sentiment.js';
import { buildCase, buildKeyPoints } from './proposal.js';

const r2 = (x) => Math.round(x * 100) / 100;
const eligible = (slot) => SLOT_ELIGIBILITY[slot] || [slot];

// How hard each kind of move is pressed by the clock. A lineup change is
// worthless once kickoff passes; a trade has weeks of runway.
const URGENCY = { lineup: 3.2, waiver: 1.6, trade: 0.9, info: 0.35 };

/* Minimum edge before a move is worth making.
 * Weekly projections have an SD near 6.8, so the gap between two players has
 * an SD near 9.6 and a 1-point edge is right 54% of the time. Waiver and trade
 * floors sit higher since those cost a drop, FAAB or an asset. Byes and injured
 * starters are never filtered, they're certainties rather than edges.
 */
// Below this two players are the same player as far as the numbers go, and
// there is nothing to discuss. Between here and the start/sit floor the
// projection cannot settle it, so the decision moves to evidence the
// projection has not absorbed yet.
export const COIN_FLIP_MIN = 0.75;

export const THRESHOLDS = {
  startSit: 2.5,       // points this week — about 60% confidence
  waiverPerWeek: 1.5,  // points per remaining week
  tradeGain: 8.0,      // points rest-of-season
};

/* Plays that are worth real money but are not safe calls: a trade the other
 * manager will probably refuse, or a free agent who does nothing this week but
 * could matter later. Kept out of the main list so that list stays unanimous,
 * and surfaced separately so they are not simply lost.
 */
const SPECULATIVE_TRADE_GAIN = 12.0;
const SPECULATIVE_STASH_GAIN = 8.0;

/** Which deadline governs this move — the basis for how the list is grouped. */
function bucketOf(kind) {
  if (kind === 'waiver') return 'waivers';
  if (kind === 'trade') return 'trades';
  return 'lineup';       // start_sit and alerts both lock at kickoff
}

const TIERS = [[6, 1, 'Do now'], [2, 2, 'This week'],
               [0.6, 3, 'Worth doing'], [0, 4, 'Optional']];
const tierOf = (w) => {
  const t = TIERS.find(([th]) => w >= th) || [0, 4, 'Optional'];
  return { priority: t[1], label: t[2] };
};

export async function buildReport(leagueId, userId, { anonymize = false,
                                                      source = null,
                                                      onProgress = () => {} } = {}) {
  onProgress('Reading league settings…');
  const state = await LeagueState.load(leagueId, userId, { anonymize, source });
  const rules = state.rules;
  const week = state.currentWeek;
  const me = state.me;

  // Season totals give every player a rest-of-season baseline in one call;
  // the current week drives start/sit. Later weeks refine both, loaded after
  // the first paint so the page isn't blocked on 14 requests.
  onProgress('Scoring every NFL player under your rules…');
  const [, , injuries, kickoffs, sentiment] = await Promise.all([
    state.projections.loadSeason(),
    state.projections.loadWeek(week),
    // News and schedule are enhancements: if ESPN is unreachable we fall back
    // to the Sleeper designation rather than failing the whole report.
    fetchInjuryReport().catch(() => new Map()),
    fetchKickoffs(state.season, week).catch(() => new Map()),
    fetchSentiment().catch(() => new Map()),
  ]);
  state.players.attachInjuries(injuries);
  state.injuries = injuries;
  state.kickoffs = kickoffs;
  state.sentiment = sentiment;

  return assemble(state, { onProgress });
}

/** Load remaining weeks so byes and rest-of-season sharpen. */
export async function refine(state, onProgress = () => {}) {
  const week = state.currentWeek;
  const last = Math.min(rulesLastWeek(state), week + 12);
  const weeks = [];
  for (let w = week + 1; w <= last; w++) weeks.push(w);
  for (let i = 0; i < weeks.length; i += 3) {
    await Promise.all(weeks.slice(i, i + 3).map(w =>
      state.projections.loadWeek(w).catch(() => null)));
    onProgress(`Refining schedule (${Math.min(i + 3, weeks.length)}/${weeks.length} weeks)…`);
  }
  state.projections.byeCache = null;
}

/** The steps that make the roster legal, written as actions. */
function rosterActions(state, fix, weekPts, kickoffOf, at) {
  const rules = state.rules;
  const out = [];
  const name = (pid) => state.players.name(pid);
  const lockNote = (pid) => {
    const ko = kickoffOf(pid);
    return ko ? `Before ${at(ko)}` : 'Now, before anything else';
  };
  const overText = fix.over_by > 0
    ? `You have ${fix.active_count} players on a ${fix.limit}-man roster, ${fix.over_by} over the limit. Sleeper will not process an add, claim or trade until that is fixed.`
    : '';

  for (const pid of fix.activate) {
    const p = state.players.get(pid);
    out.push({
      kind: 'roster', headline: `ACTIVATE ${name(pid)} from IR`,
      detail: `${pronouns(p?.position).Subj} is no longer listed as injured, so ${pronouns(p?.position).subj} can't stay on IR.`,
      payload: { player_id: pid, move: 'activate' },
      impact: 0, per_week: 0, weight: 9, horizon: 'Now, before anything else',
      reasoning: [{ h: 'Why this comes first', t:
        `Sleeper freezes a roster that has a healthy player sitting on IR. No `
        + `add, drop or trade goes through until ${name(pid)} is moved back.` }],
    });
  }

  for (const pid of fix.toIR) {
    const p = state.players.get(pid);
    const q = pronouns(p?.position);
    const needed = fix.over_by > 0 || fix.activate.length > 0;
    out.push({
      kind: 'roster', headline: `MOVE ${name(pid)} to IR`,
      detail: `Listed ${p?.injury_status || 'injured'} and you have an open IR slot. `
        + `Frees a bench spot for nothing.`,
      payload: { player_id: pid, move: 'ir' },
      impact: 0, per_week: 0, weight: needed ? 8 : 1.2,
      horizon: needed ? 'Now, before anything else' : lockNote(pid),
      reasoning: [
        ...(needed ? [{ h: 'Why', t: overText + ' Parking an injured player on IR '
          + 'clears the space without losing anyone.' }] : []),
        { h: 'What it costs', t:
          `Nothing. ${name(pid)} is projected ${(weekPts[pid] || 0).toFixed(1)} this `
          + `week and stays on your team. When ${q.subj} is cleared, move `
          + `${q.obj} back to the bench, and you will need a free spot then, `
          + `so this site will tell you who to cut at that point.` },
      ],
    });
  }

  for (const d of fix.drops) {
    const q = pronouns(d.position);
    const why = [
      { h: 'Why you have to cut someone', t: overText
        + (fix.toIR.length ? ` Moving ${fix.toIR.map(name).join(' and ')} to IR `
           + `is not enough on its own.` : fix.open_ir === 0 && rules.reserveSlots
           ? ' Your IR slots are full.' : ' Nobody else on your roster qualifies for IR.') },
      { h: `Why ${d.name}`, t:
        `Every player was tested by taking him off your roster and re-setting the `
        + `best lineup without him. Losing ${d.name} costs `
        + `${d.cost.toFixed(1)} points rest-of-season`
        + (d.cost < 0.5 ? ', which is effectively nothing' : '')
        + `, the least of anyone ${d.starts_now ? '' : 'outside this week’s lineup'}.`
        + (d.replaced_by?.length ? ` ${d.replaced_by.join(' and ')} would take `
           + `${q.poss} spot in your lineup.` : ` ${q.Subj} does not start for you in any week, so the lineup does not change.`) },
    ];
    if (d.next) why.push({ h: 'The next cheapest', t:
      `${d.next.name} would cost ${d.next.cost.toFixed(1)}`
      + (d.next.starts_now ? ' and starts for you this week' : '')
      + `. That gap is why ${d.name} goes and ${d.next.name} stays.` });
    out.push({
      kind: 'roster', headline: `DROP ${d.name}`,
      detail: `Costs ${d.cost.toFixed(1)} pts rest of season, the cheapest cut on your roster.`,
      payload: { player_id: d.player_id, move: 'drop', cost: d.cost },
      // Below the IR moves: parking someone is free and comes first.
      impact: 0, per_week: 0, weight: 7.5,
      horizon: 'Now, before anything else',
      reasoning: why,
    });
  }
  return out;
}

const rulesLastWeek = (state) => Math.max(state.currentWeek,
                                          state.rules.playoffWeekStart - 1);

/* The report is a plan, not a menu. Each stage is worked out against the
 * roster the earlier stages leave behind: the roster is made legal first,
 * claims are made against that legal roster, and the lineup is set from the
 * players you will actually have. So no step can contradict, repeat or offer
 * an alternative to another one.
 *
 * The planning mutates a copy of your team installed in `state`; the real one
 * is put back afterwards so the next pass starts from the truth again.
 */
export async function assemble(state, opts = {}) {
  const myId = state.myRosterId;
  const original = myId ? state.teams[myId] : null;
  try { return await assemblePlan(state, opts); }
  finally { if (original) state.teams[myId] = original; }
}

async function assemblePlan(state, { onProgress = () => {} } = {}) {
  const floor = THRESHOLDS;
  const rules = state.rules;
  const week = state.currentWeek;
  let me = state.me;
  const weeksLeft = Math.max(1, state.weeksRemaining);

  const weekMap = state.projections.weeks.get(week) || {};
  const weekPts = {};      // risk-adjusted: projection x odds he suits up
  const weekRaw = {};      // exactly what Sleeper's app shows
  for (const pid in weekMap) {
    weekPts[pid] = state.projections.points(pid, week);
    weekRaw[pid] = state.projections.points(pid, week, false);
  }

  const ros = state.projections.restOfSeason(week, rules.playoffWeekStart - 1);
  for (const pid in ros) {
    const p = state.players.get(pid);
    if (p && (p.rosMultiplier ?? 1) < 1) ros[pid] = r2(ros[pid] * p.rosMultiplier);
  }

  const levels = replacementLevels(rules, ros, state.players);
  const changes = await detectChanges(state);

  const actions = [];
  let lineup = null, lineupGain = 0, waivers = [], drops = [], trades = [];
  let lineupLocked = false, movableCount = 0;
  let tradeNote = '', faabLeft = 0;
  let rosterFix = null;
  let lineupUnclaimed = 0;
  let startersBefore = [];
  const nextWaiver = rules.nextWaiverRun();
  const added = new Set();          // players the plan brings in
  const addTiming = new Map();      // pid -> { instant, at, helpsThisWeek }

  // Once a player's game kicks off he is frozen where he is. A starter stays
  // in his slot and a benched player stays benched, so the optimiser may only
  // shuffle the players who can still move. Optimising the whole roster
  // instead advertises points that cannot actually be collected.
  const gameOf = (pid) => {
    const tm = state.players.get(pid)?.team;
    return tm ? state.kickoffs?.get(String(tm).toUpperCase()) : null;
  };
  const isLocked = (pid) => Boolean(gameOf(pid)?.started);
  const kickoffOf = (pid) => gameOf(pid)?.kickoff || null;
  const at = (d) => d.toLocaleString(undefined,
    { weekday: 'short', hour: 'numeric', minute: '2-digit' });

  // Drop moves whose edge is too small to be worth acting on. Warnings stay:
  // a bye week is a certainty, not a projected edge.
  const belowFloor = (a) => {
    if (a.kind === 'start_sit') return !a.payload?.forced && a.impact < floor.startSit;
    if (a.kind === 'waiver') return a.per_week < floor.waiverPerWeek;
    if (a.kind === 'trade') return a.impact < floor.tradeGain;
    return false;
  };
  // High upside, low certainty. Worth seeing, but not alongside the calls that
  // are simply correct.
  const isSpeculative = (a) => {
    if (a.kind === 'trade') {
      return a.payload?.acceptance === 'long shot' && a.impact >= SPECULATIVE_TRADE_GAIN;
    }
    if (a.kind === 'waiver') {
      // Does nothing for you this week, but could pay off across the season.
      return (a.payload?.marginal_week ?? 1) < 0.5 && a.impact >= SPECULATIVE_STASH_GAIN;
    }
    return false;
  };

  if (me) {
    // The full ranking is taken from the roster as it stands, so the drop
    // card answers "who is cheapest to cut" for the team you actually have.
    drops = dropCandidates(state, ros, 10, weekPts);

    startersBefore = [...me.starters];

    /* ---- step 1: make the roster legal ---- */
    rosterFix = planRosterFix(state, me, ros, weekPts, { isLocked });
    me = applyMoves(cloneTeam(me), {
      toIR: rosterFix.toIR, activate: rosterFix.activate,
      drop: rosterFix.drops.map(d => d.player_id),
    });
    state.teams[state.myRosterId] = me;
    actions.push(...rosterActions(state, rosterFix, weekPts, kickoffOf, at));
  }
  const currentStarters = me ? [...me.starters] : [];
  // Who held a starting slot before an earlier step emptied it, and why.
  const vacatedBy = new Map();      // pid -> 'moved to IR' | 'dropped'
  if (rosterFix) {
    rosterFix.toIR.forEach(p => vacatedBy.set(p, 'moved to IR'));
    rosterFix.drops.forEach(d => vacatedBy.set(d.player_id, 'dropped'));
  }

  if (me) {
    /* ---- step 2: waivers, against the legal roster ---- */
    onProgress('Ranking the waiver wire…');
    faabLeft = Math.max(0, rules.waiverBudget - me.waiver_budget_used);
    let trending = {};
    try {
      for (const t of (await Sleeper.trending('add', 24, 200)) || [])
        trending[String(t.player_id)] = t.count;
    } catch {}

    // Whether a pickup is instant or waits for the waiver run decides whether
    // he can be in this week's lineup.
    const now = new Date();
    const runAt = rules.nextWaiverRunAt(now);
    const kicks = [...(state.kickoffs || new Map()).values()].map(g => +g.kickoff);
    const firstKick = kicks.length ? new Date(Math.min(...kicks)) : null;
    // Between the weekly rollover and the waiver run, everyone unowned is on
    // waivers. After the run they are free agents, except recent drops and
    // anyone whose game has already started.
    const waiverPeriod = Boolean(runAt && firstKick && runAt < firstKick);
    const onWaivers = new Set();
    if (!state.isLocal && runAt) {
      const clearMs = (rules.settings.waiver_clear_days ?? 2) * 864e5;
      for (const w of [week, week - 1]) {
        if (w < 1) continue;
        try {
          for (const tx of (await Sleeper.transactions(rules.leagueId, w)) || []) {
            if (tx.status !== 'complete' || !tx.drops) continue;
            const t = tx.status_updated || tx.created || 0;
            if (now - t < clearMs) for (const pid in tx.drops) onWaivers.add(String(pid));
          }
        } catch {}
      }
    }
    const timingOf = (pid) => {
      if (!runAt) return { instant: true, at: now };
      if (waiverPeriod || !firstKick || onWaivers.has(pid) || isLocked(pid))
        return { instant: false, at: runAt };
      return { instant: true, at: now };
    };

    waivers = recommendWaivers(state, ros, weekPts, levels, trending, 5);

    for (const w of waivers) {
      const timing = timingOf(w.player_id);
      w.instant = timing.instant;
      const ko = kickoffOf(w.player_id);
      const helpsThisWeek = Boolean(ko && ko > timing.at
                                    && state.projections.hasGame(w.player_id, week));
      const cost = timing.instant
        ? ' — free agent, no bid needed'
        : rules.usesFaab && w.faab_bid
          ? ` — bid $${w.faab_bid} (${w.faab_pct.toFixed(0)}% of your $${faabLeft})`
          : (!rules.usesFaab && me.waiver_position
             ? ` — uses your #${me.waiver_position} waiver priority` : '');
      const perWeek = w.net_gain / weeksLeft;
      const a = {
        kind: 'waiver',
        headline: `${timing.instant ? 'ADD' : 'CLAIM'} ${w.name} (${w.position}-${w.team})`
                  + (w.drop_id ? `, drop ${w.drop_name}` : '') + cost,
        detail: w.rationale,
        payload: {
          player_id: w.player_id, bid: timing.instant ? 0 : w.faab_bid,
          drop_id: w.drop_id, instant: timing.instant,
          net_gain: w.net_gain, marginal_week: w.marginal_week,
          alternatives: w.alternatives.map(a => ({
            label: `${a.name} (${a.position}-${a.team})`, bid: a.faab_bid,
            net_gain: a.net_gain, drop_name: a.drop_name, detail: a.rationale,
          })),
        },
        impact: w.net_gain, per_week: r2(perWeek), unit: 'ros',
        weight: perWeek * URGENCY.waiver,
        horizon: timing.instant
          ? (helpsThisWeek ? `Add before ${at(ko)} to use ${pronouns(w.position).obj} this week`
                           : 'Free agent — add any time')
          : `Waivers run ${nextWaiver}`,
        reasoning: w.reasoning,
      };
      actions.push(a);

      // A claim that is going in the plan changes the roster everything after
      // it is planned against.
      if (belowFloor(a) || isSpeculative(a)) continue;
      a.planned = true;
      added.add(w.player_id);
      addTiming.set(w.player_id, { ...timing, helpsThisWeek });
      // Only a pickup that lands before his kickoff joins this week's lineup.
      // A later claim still happens, but the player he replaces plays first.
      if (helpsThisWeek) {
        applyMoves(me, { add: [w.player_id], drop: w.drop_id ? [w.drop_id] : [] });
        if (w.drop_id) vacatedBy.set(w.drop_id, 'dropped');
      }
    }
  }

  if (me) {
    const rosterWeek = {};
    for (const pid of me.activePlayers()) rosterWeek[pid] = weekPts[pid] || 0;
    const positions = state.positionsMap(rosterWeek);

    const allSlots = rules.startingSlots;
    // Same-week pickups and IR moves may have vacated a starting slot.
    me.starters.forEach((pid, i) => { currentStarters[i] = pid; });
    const onRoster = new Set(me.activePlayers());
    const pinned = new Map();          // slot index -> player already locked in
    currentStarters.forEach((pid, i) => {
      if (pid && pid !== '0' && i < allSlots.length && onRoster.has(pid)
          && isLocked(pid)) pinned.set(i, pid);
    });
    const pinnedIds = new Set(pinned.values());
    const freeIdx = allSlots.map((_, i) => i).filter(i => !pinned.has(i));
    // `optimize` only reads `startingSlots`, so a shim restricts it to the
    // slots that are still open.
    const freeRules = { startingSlots: freeIdx.map(i => allSlots[i]) };

    // Fit a chosen set of starters into the open slots, or null if they can't
    // all be placed legally. The tiny bonus makes a zero-point player (on a
    // bye, say) still count as placed rather than left out.
    const arrange = (set) => {
      const pts = {};
      for (const pid of set) if (!pinnedIds.has(pid)) pts[pid] = (weekPts[pid] || 0) + 1e-3;
      const lu = optimize(freeRules, pts, positions);
      if (lu.starterIds().length !== Object.keys(pts).length) return null;
      const filled = new Array(allSlots.length).fill(null);
      for (const [i, pid] of pinned) filled[i] = pid;
      lu.slots.forEach((sl, k) => { filled[freeIdx[k]] = sl.player_id; });
      return filled;
    };
    const valueOf = (filled) =>
      filled.reduce((t, p) => t + (p ? (weekPts[p] || 0) : 0), 0);
    const isDead = (pid) => !state.projections.hasGame(pid, week)
      || ['Out', 'IR', 'Doubtful'].includes(state.players.get(pid)?.injury_status);

    /* ---- start / sit ----
     * One swap at a time, each made against the lineup the previous swap left.
     * Every step is therefore a move you can actually make in Sleeper, in that
     * order, and the lineup card is simply where the steps end up. Pairing the
     * optimal lineup against the current one instead breaks on chains (a TE
     * into the TE slot pushes the old TE to FLEX and a WR out), which showed
     * up as phantom "empty slot" moves while a player on bye stayed in.
     */
    let prev = currentStarters.slice(0, allSlots.length)
      .map(p => (p && p !== '0' && onRoster.has(p)) ? p : null);
    while (prev.length < allSlots.length) prev.push(null);
    const startTotal = valueOf(prev);
    const accepted = [];
    const misses = new Map();      // `${in}|${out}` -> best near-miss swap

    for (let guard = 0; guard <= allSlots.length; guard++) {
      const S = new Set(prev.filter(Boolean));
      const base = valueOf(prev);
      const bench = [...onRoster].filter(p => !S.has(p) && !isLocked(p));
      const outs = [...S].filter(p => !pinnedIds.has(p));
      const emptyAt = prev.findIndex((p, i) => !p && !pinned.has(i));
      let best = null;
      for (const e of bench) {
        const ePos = positions[e];
        for (const l of emptyAt >= 0 ? [null, ...outs] : outs) {
          // Simplest case first: he takes the departing player's exact slot,
          // so nobody else has to move.
          let filled = null;
          const idx = l ? prev.indexOf(l) : emptyAt;
          if (idx >= 0 && eligible(allSlots[idx]).includes(ePos)) {
            filled = prev.slice(); filled[idx] = e;
          } else {
            const next = new Set(S); if (l) next.delete(l); next.add(e);
            filled = arrange(next);
          }
          if (!filled) continue;
          const g = r2(valueOf(filled) - base);
          const forced = !l || isDead(l);
          const ok = g >= floor.startSit || (forced && g > 0.05);
          if (ok) {
            if (!best || g > best.g) best = { e, l, g, forced, filled, idx };
          } else if (g >= COIN_FLIP_MIN) {
            const k = `${e}|${l}`;
            if (!misses.has(k) || misses.get(k).g < g)
              misses.set(k, { e, l, g, forced: false, filled });
          }
        }
      }
      if (!best) break;
      // Anyone already in the lineup who has to change slot to make room.
      best.shifts = [];
      best.filled.forEach((pid, i) => {
        if (!pid || pid === best.e) return;
        const was = prev.indexOf(pid);
        if (was >= 0 && allSlots[was] !== allSlots[i])
          best.shifts.push({ pid, from: allSlots[was], to: allSlots[i] });
      });
      accepted.push(best);
      prev = best.filled;
    }

    // The near misses that are still open against the final lineup become
    // coin-flip items, never plan steps. One per player, best first.
    const finalSet = new Set(prev.filter(Boolean));
    const usedIn = new Set(), usedOut = new Set();
    const nearMisses = [...misses.values()]
      .filter(m => !finalSet.has(m.e) && m.l && finalSet.has(m.l))
      .sort((x, y) => y.g - x.g)
      .filter(m => {
        if (usedIn.has(m.e) || usedOut.has(m.l)) return false;
        usedIn.add(m.e); usedOut.add(m.l); return true;
      })
      .slice(0, 3);

    const startersSet = new Set(prev.filter(Boolean));
    const finalFilled = prev;
    lineup = {
      slots: allSlots.map((slot, i) => ({
        slot, player_id: finalFilled[i],
        points: r2(finalFilled[i] ? (weekPts[finalFilled[i]] || 0) : 0),
        locked: finalFilled[i] ? isLocked(finalFilled[i]) : false,
      })),
      bench: Object.entries(rosterWeek)
        .filter(([pid]) => !startersSet.has(pid))
        .map(([pid, pts]) => [pid, r2(pts)])
        .sort((a, b) => b[1] - a[1]),
      total: r2(valueOf(finalFilled)),
      starterIds: () => finalFilled.filter(Boolean),
    };
    lineupGain = freeIdx.length ? r2(lineup.total - startTotal) : 0;
    lineupLocked = !freeIdx.length;
    movableCount = freeIdx.length;
    // What a full re-shuffle would add on top, for the "not worth it" note.
    const movable = {};
    for (const pid of onRoster) if (!isLocked(pid)) movable[pid] = weekPts[pid] || 0;
    const ideal = optimize(freeRules, movable, positions).total
      + [...pinnedIds].reduce((t, p) => t + (weekPts[p] || 0), 0);
    lineupUnclaimed = Math.max(0, r2(ideal - lineup.total));

    const slotOf = (filled, pid) => allSlots[filled.indexOf(pid)] || '';
    const pairs = [
      ...accepted.map(x => [x.e, x.l, slotOf(x.filled, x.e), x.g, x.forced, x.shifts, false,
                            x.l ? null : startersBefore[x.idx]]),
      ...nearMisses.map(x => [x.e, x.l, slotOf(x.filled, x.e), x.g, false, [], true]),
    ];

    for (const [newPid, outPid, slotName, gain, forced, shifts, nearMiss, heldBy] of pairs) {
      // An empty slot an earlier step emptied is named after its last owner.
      const was = heldBy && vacatedBy.has(heldBy)
        ? ` in place of ${state.players.name(heldBy)} (${vacatedBy.get(heldBy)} above)` : '';
      const np = state.players.get(newPid);
      const op = outPid ? state.players.get(outPid) : null;
      const inPts = weekPts[newPid] || 0;
      const outPts = outPid ? (weekPts[outPid] || 0) : 0;
      const shiftText = shifts.map(x => `${state.players.name(x.pid)} moves from ${x.from} to ${x.to}`).join(', ');

      let driver = '', tail = '';
      if (op && !state.projections.hasGame(outPid, week)) {
        driver = `${op.name} is on a bye this week and will score zero`;
        tail = ` — ${op.name} is on BYE`;
      } else if (op && ['Out', 'IR', 'Doubtful'].includes(op.injury_status)) {
        driver = `${op.name} is listed ${op.injury_status}`;
        tail = ` — ${op.name} is ${op.injury_status}`;
      }

      // Work out health and timing first: when a player's number has been
      // adjusted for injury, that is the story, and the deadline to re-check
      // it becomes the headline rather than a footnote.
      const injuryOf = (id) => {
        const pl = state.players.get(id);
        if (!pl || pl.playProb == null || pl.playProb > 0.95) return null;
        return { name: pl.name, position: pl.position, prob: pl.playProb,
                 reason: pl.injuryReason, note: pl.injuryNote,
                 raw: weekRaw[id] ?? 0 };
      };
      const inInj = injuryOf(newPid);
      const outInj = outPid ? injuryOf(outPid) : null;
      const injured = [inInj, outInj].filter(Boolean);

      // A swap closes at the earlier of the two kickoffs — whoever plays first
      // locks first, and after that the other can't be moved into his slot.
      const dl = swapDeadline(state.kickoffs || new Map(), np?.team, op?.team);
      const fromAdd = added.has(newPid);

      const why = [];

      if (injured.length) {
        const detail = injured.map(i => {
          const q = pronouns(i.position);
          return `${i.name} projects ${i.raw.toFixed(1)} if ${q.subj} plays, but the `
            + `latest report has ${q.obj} about ${Math.round(i.prob * 100)}% to suit up `
            + `(${i.reason}), worth roughly ${(i.raw * i.prob).toFixed(1)} once `
            + `that is priced in`;
        }).join('. ');

        if (dl && !dl.locked) {
          // The single most useful thing here is when to look again.
          why.push({ h: `Look again ${at(dl.checkBy)}`, t:
            `This one turns on health rather than form, so the figure here is `
            + `deliberately below the one in the Sleeper app. ${detail}. `
            + `Inactives are published about ${INACTIVES_LEAD_MIN} minutes before the `
            + `${at(dl.locksAt)} kickoff, so ${at(dl.checkBy)} is the last moment `
            + `the news can still change your mind. If ${pronouns(injured[0].position).subj} `
            + `is active, the gap narrows sharply and this may be worth reversing.` });
        } else if (dl && dl.locked) {
          why.push({ h: 'This window has closed', t:
            `The first of these two has already kicked off, so the swap is no `
            + `longer possible for week ${week}. ${detail}.` });
        } else {
          why.push({ h: 'Hinges on health, not form', t:
            `${detail}. Inactives are published about ${INACTIVES_LEAD_MIN} minutes `
            + `before kickoff — check then.` });
        }

        for (const i of injured) {
          if (!i.note) continue;
          why.push({ h: `What's being reported on ${i.name}`, t: `“${i.note}”` });
        }
      }

      why.push({ h: 'The swap', t:
        `${np?.name ?? newPid} projects ${inPts.toFixed(1)} points in week ${week}`
        + (op ? ` against ${outPts.toFixed(1)} for ${op.name}` : ' and the slot is currently empty')
        + ` — a swing of ${gain.toFixed(1)} points, scored under your league's `
        + `settings rather than generic rankings.`
        + (injured.length ? ' Those figures already account for the injury risk above.' : '') });

      if (driver) why.push({ h: 'Why now', t: driver[0].toUpperCase() + driver.slice(1) + '.' });

      if (op && !injured.length) {
        const conf = edgeConfidence(gain, np?.position, op.position);
        why.push({ h: 'How sure is this?', t:
          `Weekly projections miss by about 6.8 points on average, so a `
          + `${gain.toFixed(1)}-point edge is right roughly `
          + `${Math.round(conf * 100)}% of the time. Worth making because the `
          + `move is free and reversible until kickoff — but it is an edge, not `
          + `a certainty.` });
      }

      why.push({ h: 'Why this player and not another', t:
        `Your whole roster is assigned to slots at once rather than picked one `
        + `at a time, so flex spots get filled optimally. This is the best legal `
        + `arrangement of the players you have, totalling ${lineup.total.toFixed(1)} `
        + `projected points.` });

      // For a clean projection edge the deadline is useful but secondary.
      if (dl && !injured.length) {
        const bindingName = dl.bindingTeam === np?.team ? np?.name : op?.name;
        why.push({ h: dl.locked ? 'This window has closed' : 'When it closes', t:
          dl.locked
            ? `${bindingName}'s game has already kicked off, so this swap is no `
              + `longer possible for week ${week}.`
            : `Both players have to be movable, so the window shuts when the `
              + `first of them kicks off — ${bindingName} at ${at(dl.locksAt)}.` });
      }

      // A swap whose window has already shut is not advice, it is a regret.
      if (dl && dl.locked) continue;

      if (fromAdd) {
        const tm = addTiming.get(newPid);
        const q = pronouns(np?.position);
        why.unshift({ h: 'Do this after the pickup', t: tm?.instant
          ? `${np?.name} is not on your roster until you add ${q.obj} in the step above. Add first, then set the lineup.`
          : `${np?.name} arrives when waivers run (${nextWaiver}). Once the claim goes through, put ${q.obj} in this slot before ${q.poss} game.` });
      }

      actions.push({
        kind: 'start_sit',
        headline: `START ${np?.name ?? newPid} at ${slotName}`
                  + (op ? ` over ${op.name}` : was || ' (empty slot)') + tail,
        detail: (fromAdd ? 'Once the pickup above goes through. ' : '')
          + `${inPts.toFixed(1)} proj vs ${outPts.toFixed(1)} — +${gain.toFixed(1)} pts in week ${week}`
          + (shiftText ? `. To make room, ${shiftText}.` : ''),
        payload: { player_id: newPid, slot: slotName, bench: outPid, gain,
                   injury_in: inInj, injury_out: outInj, after_add: fromAdd,
                   forced, near_miss: nearMiss },
        injury_driven: injured.length > 0,
        impact: gain, per_week: gain, weight: gain * URGENCY.lineup,
        unit: 'week', confidence: op
          ? edgeConfidence(gain, np?.position, op.position) : null,
        deadline: dl ? {
          locks_at: dl.locksAt.toISOString(),
          check_by: dl.checkBy.toISOString(),
          locked: dl.locked,
          hours_left: Math.round(dl.hoursLeft * 10) / 10,
        } : null,
        horizon: dl ? dl.label : `Before week ${week} kickoff`,
        reasoning: why,
      });
    }

    // Starters with no viable replacement — a warning, not a swap.
    for (const pid of startersSet) {
      if (isLocked(pid) || !isDead(pid)) continue;
      const p = state.players.get(pid);
      if (!p) continue;
      const onBye = !state.projections.hasGame(pid, week);
      const label = onBye ? `on BYE in week ${week}` : p.injury_status;
      actions.push({
        kind: 'alert',
        headline: `${p.name} is ${label} and is in your lineup`,
        detail: 'They will score zero. Nothing on your bench can fill the slot, '
              + 'and no free agent cleared the bar, so this one stays.',
        payload: { player_id: pid },
        impact: 0, per_week: 0, weight: 7,
        horizon: `Before week ${week} kickoff`,
        reasoning: [
          { h: 'What happens if you do nothing', t:
            `${p.name} takes a zero in a starting slot. In a ${rules.numTeams}-team `
            + `league that is usually the difference in a weekly matchup.` },
          { h: 'Why no swap is offered', t:
            'No player on your bench is eligible for that slot, so there is no '
            + 'free fix. The waiver wire is the only way out.' },
        ],
      });
    }

    // Claims that land after this week's games still happen. Trades are
    // planned against the roster you will have once they do.
    for (const [pid, tm] of addTiming) {
      if (tm.helpsThisWeek) continue;
      const w = waivers.find(x => x.player_id === pid);
      // The player being cut can still be in this week's lineup, since the
      // claim only goes through after his game. Say so, or the two steps look
      // like they disagree.
      if (w?.drop_id && startersSet.has(w.drop_id)) {
        const a = actions.find(x => x.kind === 'waiver' && x.payload.player_id === pid);
        const dn = state.players.name(w.drop_id);
        const q = pronouns(state.players.get(w.drop_id)?.position);
        if (a) {
          a.detail = `${dn} still starts for you this week. ${q.Subj} only leaves when the claim goes through. ` + a.detail;
          a.reasoning.unshift({ h: `Why ${dn} is in your lineup and also being dropped`, t:
            `Claims process ${nextWaiver}, after this week's games. Until then `
            + `${dn} is still yours and still your best option in that slot, so `
            + `start ${q.obj} this week and let the claim replace ${q.obj} after.` });
        }
      }
      applyMoves(me, { add: [pid], drop: w?.drop_id ? [w.drop_id] : [] });
    }

    /* ---- trades ---- */
    onProgress('Searching every roster for trades…');
    // Search below the display floor so long-shot ideas can still surface
    // in the speculative list rather than never being built.
    trades = findTrades(state, ros, levels, { limit: 8, minMyGain: floor.tradeGain,
                                               keep: added });
    if (!trades.length) {
      const chips = tradeChips(state, ros, levels, 2)
        .map(([pid]) => state.players.name(pid));
      tradeNote = 'No trade currently improves both teams — rosters across the '
        + 'league are still balanced, which is normal early. ';
      if (chips.length) {
        tradeNote += `Your most tradeable surplus is ${chips.join(' and ')}: real `
          + `value your lineup can't start. Shop ${chips.length > 1 ? 'them'
              : pronouns(state.players.get(chipIds[0])?.position).obj} `
          + `to a manager thin at that position and re-check after the first `
          + `injuries land.`;
      }
    }
    // Build the pitch for each deal while the roster maths is still in scope.
    for (const tr of trades) {
      try {
        const c = buildCase(state, tr, ros);
        if (c) tr.proposal = { ...c, points: buildKeyPoints(c) };
      } catch { /* a missing partner should not sink the report */ }
    }

    const acceptFactor = { likely: 1, possible: 0.7, 'long shot': 0.4 };
    const startingThisWeek = new Set(lineup ? lineup.starterIds() : []);
    for (const t of trades.slice(0, 4)) {
      const perWeek = t.my_gain / weeksLeft;
      // A trade chip who is also in this week's lineup isn't a contradiction,
      // but the ordering matters and is worth saying out loud.
      const alsoStarting = t.send.filter(p => startingThisWeek.has(p))
                                 .map(p => state.players.name(p));
      actions.push({
        kind: 'trade',
        headline: `OFFER ${t.partner_name}: ${t.summary}`,
        detail: t.rationale,
        payload: {
          partner: t.partner_roster_id, send: t.send, receive: t.receive,
          my_gain: t.my_gain, their_gain: t.their_gain, acceptance: t.acceptance,
          alternatives: t.alternatives.map(a => ({
            label: `${a.partner_name}: ${a.summary}`, net_gain: a.my_gain,
            detail: `${a.acceptance} to be accepted · them +${a.their_gain.toFixed(1)}`,
          })),
        },
        impact: t.my_gain, per_week: r2(perWeek), unit: 'ros',
        weight: perWeek * URGENCY.trade * (acceptFactor[t.acceptance] ?? 0.5),
        horizon: `Trade deadline week ${rules.tradeDeadlineWeek}`,
        reasoning: [
          ...(alsoStarting.length ? [{ h: 'Set your lineup first', t:
            `${alsoStarting.join(' and ')} ${alsoStarting.length > 1 ? 'are' : 'is'} `
            + `in your week ${week} lineup. Trades take days to negotiate and `
            + `lineups lock at kickoff, so start ${alsoStarting.length > 1 ? 'them'
                : pronouns(state.players.get(t.send.find(p => startingThisWeek.has(p)))?.position).obj} `
            + `this week and let the offer run, just replace `
            + `${alsoStarting.length > 1 ? 'them'
                : pronouns(state.players.get(t.send.find(p => startingThisWeek.has(p)))?.position).obj} `
            + `if it is accepted first.` }] : []),
          { h: 'What you gain', t:
            `Your starting lineup improves by ${t.my_gain.toFixed(1)} points `
            + `rest-of-season — about ${perWeek.toFixed(1)} per week over the `
            + `${weeksLeft} weeks before playoffs.` },
          { h: 'Why they would say yes', t:
            `Their lineup improves by ${t.their_gain.toFixed(1)} too. Trades happen `
            + `when rosters are positionally imbalanced: your surplus is their `
            + `hole. ${t.rationale}` },
          { h: 'How likely it is to be accepted', t:
            `You send ${t.value_ratio.toFixed(2)}x the market value you receive, `
            + `which reads as ${t.acceptance} to be accepted.`
            + (t.value_ratio >= 0.55
               ? ' Offers that would look insulting are filtered out entirely.' : '') },
        ],
      });
    }
  }

  /* ---- the league is dumping one of your starters ---- */
  if (me && lineup) {
    for (const s of lineup.slots) {
      if (!s.player_id) continue;
      // If his game has kicked off there is nothing to be done about it, so
      // warning about the wire turning on him is just noise.
      if (s.locked) continue;
      const sent = sentimentOf(state.sentiment, s.player_id);
      if (!sent || sent.direction >= 0 || sent.strength < 0.6) continue;
      const pl = state.players.get(s.player_id);
      if (!pl) continue;
      actions.push({
        kind: 'alert',
        headline: `${pl.name} is ${sent.verdict}, and ${pronouns(pl.position).subj} is in your lineup`,
        detail: 'Projections lag news. Worth finding out what everyone else knows.',
        payload: { player_id: s.player_id, sentiment: sent },
        impact: 0, per_week: 0, weight: 2.4,
        horizon: 'Before kickoff',
        reasoning: [{ h: 'Why this is worth a look', t:
          `${pronouns(pl.position).Poss} projection still reads `
          + `${(weekRaw[s.player_id] ?? 0).toFixed(1)}, so on paper nothing has `
          + `changed. But ${sent.drops.toLocaleString()} managers dropped `
          + `${pronouns(pl.position).obj} in the last 24 hours against `
          + `${sent.adds.toLocaleString()} adds, which usually means news that `
          + `the projection has not caught up with. Worth two minutes of `
          + `reading before leaving ${pronouns(pl.position).obj} in.` }],
      });
    }
  }

  // League news (adds, drops, status changes) lives on the Activity tab.
  // It is context, not a step, and the plan already reacts to the parts of
  // it that touch your lineup.

  // A start/sit inside the error band is not a recommendation, it is a coin
  // flip. Rather than hide it or assert it, hand it over with whatever
  // evidence exists outside the projection and let the manager call it.
  const closeCalls = [];
  for (const a of actions) {
    if (a.kind !== 'start_sit') continue;
    if (a.impact >= floor.startSit || a.impact < COIN_FLIP_MIN) continue;
    if (a.payload?.forced) continue;
    const inId = a.payload.player_id;
    const outId = a.payload.bench;
    if (!outId) continue;
    const pin = state.players.get(inId);
    const pout = state.players.get(outId);
    const tie = breakTie({
      inSent: sentimentOf(state.sentiment, inId),
      outSent: sentimentOf(state.sentiment, outId),
      inProb: pin?.playProb, outProb: pout?.playProb,
      inName: pin?.name || 'the incoming player',
      outName: pout?.name || 'the current starter',
    });
    closeCalls.push({
      in_id: inId, out_id: outId,
      in_name: pin?.name || inId, out_name: pout?.name || outId,
      slot: a.payload.slot,
      gap: a.impact,
      in_points: weekRaw[inId] ?? 0,
      out_points: weekRaw[outId] ?? 0,
      tiebreak: tie,
      verdict: !tie ? 'stay put'
             : tie.favours === 'in' ? 'lean to the swap'
             : tie.favours === 'out' ? 'stay put'
             : 'stay put',
    });
  }
  closeCalls.sort((a, b) => b.gap - a.gap);

  const held = actions.filter(belowFloor);
  const rest = actions.filter(a => !belowFloor(a));
  const speculative = rest.filter(isSpeculative);
  const kept = rest.filter(a => !isSpeculative(a));
  actions.length = 0;
  actions.push(...kept);

  speculative.sort((a, b) => b.impact - a.impact);
  speculative.forEach(a => { a.bucket = bucketOf(a.kind); });

  // Numbered in the order you do them. Roster fixes unblock everything else;
  // lineup swaps on players you already have are free and go next; then the
  // pickups, then the lineup changes that need those pickups, then anything
  // to keep an eye on, then offers, which take days anyway. Within a stage the
  // bigger move goes first.
  const stageOf = (a) => {
    if (a.kind === 'roster') return 0;
    if (a.kind === 'start_sit') return a.payload?.after_add ? 3 : 1;
    if (a.kind === 'waiver') return 2;
    if (a.kind === 'alert') return 4;
    return 5;
  };
  actions.sort((a, b) => (stageOf(a) - stageOf(b)) || (b.weight - a.weight));
  actions.forEach((a, i) => {
    a.rank = i + 1;
    const t = tierOf(a.weight);
    a.priority = t.priority;
    a.tier_label = t.label;
    a.bucket = bucketOf(a.kind);
  });

  const deadlines = [
    week < rules.tradeDeadlineWeek
      ? `Trade deadline: week ${rules.tradeDeadlineWeek} (${rules.tradeDeadlineWeek - week} weeks away)`
      : 'Trade deadline has PASSED — waivers only from here',
    `Playoffs begin week ${rules.playoffWeekStart} (${rules.playoffTeams} of ${rules.numTeams} teams qualify)`,
  ];

  const names = {};
  const collect = (pid) => {
    if (!pid || names[pid]) return;
    const p = state.players.get(pid);
    if (p) names[pid] = {
      name: p.name, position: p.position, team: p.team,
      injury: p.injury_status || '',
      play_prob: p.playProb ?? null,
      injury_reason: p.injuryReason || '',
      injury_note: p.injuryNote || '',
      raw: weekRaw[pid] ?? null,
    };
  };
  currentStarters.forEach(collect);
  lineup?.slots.forEach(s => collect(s.player_id));
  lineup?.bench.forEach(([p]) => collect(p));
  actions.forEach(a => ['player_id', 'bench', 'drop_id'].forEach(k => collect(a.payload?.[k])));
  trades.forEach(t => [...t.send, ...t.receive].forEach(collect));
  drops.forEach(d => collect(d.player_id));
  if (rosterFix) [...rosterFix.toIR, ...rosterFix.activate,
                  ...rosterFix.drops.map(d => d.player_id)].forEach(collect);

  return {
    generated_at: new Date().toISOString(),
    league_name: rules.name, league_id: rules.leagueId, week,
    my_team: me ? me.label : '(no team linked)',
    record: me ? me.record : '-',
    settings_summary: rules.describe(),
    lineup, current_starters: currentStarters, lineup_gain: lineupGain,
    lineup_unclaimed: lineupUnclaimed,
    lineup_locked: lineupLocked, movable_slots: movableCount,
    actions, waivers, drops, trades, changes, trade_note: tradeNote,
    roster_fix: rosterFix,
    faab_left: faabLeft, next_waiver: nextWaiver, deadlines,
    thresholds: floor,
    speculative,
    close_calls: closeCalls,
    waiver_day_of_week: rules.waiverDayOfWeek,
    held_back: held.length,
    // Deadline wording for each group, built from this league's own settings.
    buckets: {
      lineup: `Before kickoff`,
      waivers: `Before waivers run — ${nextWaiver}`,
      trades: `No deadline — trade deadline is week ${rules.tradeDeadlineWeek}`,
    },
    held_back_detail: held
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 6)
      .map(a => ({ headline: a.headline, impact: a.impact, kind: a.kind })),
    uses_faab: rules.usesFaab, waiver_type: rules.waiverType,
    waiver_position: me ? me.waiver_position : 0,
    player_names: names,
    _state: state,
    // Kept for the offer analyser, which re-runs the maths on demand.
    _ros: ros, _levels: levels, _weekPts: weekPts, _isLocked: isLocked,
  };
}
