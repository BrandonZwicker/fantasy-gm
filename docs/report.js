/* Fantasy GM — orchestrator. Turns league state into a ranked action queue.
 * Ported from ../gm/recommend.py.
 */

import {
  LeagueState, SLOT_ELIGIBILITY, Sleeper,
  optimize, replacementLevels, vor,
} from './engine.js';
import {
  detectChanges, dropCandidates, findTrades, recommendWaivers, tradeChips,
} from './advice.js';

const r2 = (x) => Math.round(x * 100) / 100;
const eligible = (slot) => SLOT_ELIGIBILITY[slot] || [slot];

// How hard each kind of move is pressed by the clock. A lineup change is
// worthless once kickoff passes; a trade has weeks of runway.
const URGENCY = { lineup: 3.2, waiver: 1.6, trade: 0.9, info: 0.35 };
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
  await Promise.all([
    state.projections.loadSeason(),
    state.projections.loadWeek(week),
  ]);

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

const rulesLastWeek = (state) => Math.max(state.currentWeek,
                                          state.rules.playoffWeekStart - 1);

export async function assemble(state, { onProgress = () => {} } = {}) {
  const rules = state.rules;
  const week = state.currentWeek;
  const me = state.me;
  const weeksLeft = Math.max(1, state.weeksRemaining);

  const weekMap = state.projections.weeks.get(week) || {};
  const weekPts = {};
  for (const pid in weekMap) weekPts[pid] = state.projections.points(pid, week);

  const ros = state.projections.restOfSeason(week, rules.playoffWeekStart - 1);
  for (const pid in ros) {
    const p = state.players.get(pid);
    if (p && p.availability < 1) ros[pid] = r2(ros[pid] * (0.5 + 0.5 * p.availability));
  }

  const levels = replacementLevels(rules, ros, state.players);
  const changes = await detectChanges(state);

  const actions = [];
  let lineup = null, lineupGain = 0, waivers = [], drops = [], trades = [];
  let tradeNote = '', faabLeft = 0;
  const currentStarters = me ? [...me.starters] : [];
  const nextWaiver = rules.nextWaiverRun();

  if (me) {
    const rosterWeek = {};
    for (const pid of me.activePlayers()) rosterWeek[pid] = weekPts[pid] || 0;
    const positions = state.positionsMap(rosterWeek);
    lineup = optimize(rules, rosterWeek, positions);

    const currentTotal = r2(currentStarters.reduce((s, p) => s + (weekPts[p] || 0), 0));
    lineupGain = r2(lineup.total - currentTotal);

    /* ---- start / sit ---- */
    const optimalIds = new Set(lineup.starterIds());
    const currentIds = new Set(currentStarters.filter(p => p && p !== '0'));
    const entering = [...optimalIds].filter(p => !currentIds.has(p));
    const leaving = [...currentIds].filter(p => !optimalIds.has(p))
                                   .sort((a, b) => (weekPts[a] || 0) - (weekPts[b] || 0));
    const handled = new Set();

    // Pair each incoming player with the one he actually displaces, by slot.
    // Zipping the lists by index pairs unrelated players — it will cheerfully
    // tell you to start a QB "over" a tight end.
    const pairs = [];
    lineup.slots.forEach((slot, i) => {
      const newPid = slot.player_id;
      if (!newPid || !entering.includes(newPid)) return;
      let here = currentStarters[i];
      if (here === '0' || here === '') here = null;
      let outPid = null;
      if (here && leaving.includes(here) && !handled.has(here)) {
        outPid = here;                       // he literally held this slot
      } else {
        const elig = eligible(slot.slot);
        const opts = leaving.filter(x => !handled.has(x)
                        && elig.includes(state.players.get(x)?.position));
        if (opts.length) outPid = opts.reduce((a, b) =>
          (weekPts[b] || 0) < (weekPts[a] || 0) ? b : a);
      }
      if (outPid) handled.add(outPid);
      pairs.push([newPid, outPid, slot.slot]);
    });

    for (const [newPid, outPid, slotName] of pairs) {
      const np = state.players.get(newPid);
      const op = outPid ? state.players.get(outPid) : null;
      const inPts = weekPts[newPid] || 0;
      const outPts = outPid ? (weekPts[outPid] || 0) : 0;
      const gain = r2(inPts - outPts);

      let driver = '', tail = '';
      if (op && !state.projections.hasGame(outPid, week)) {
        driver = `${op.name} is on a bye this week and will score zero`;
        tail = ` — ${op.name} is on BYE`;
      } else if (op && ['Out', 'IR', 'Doubtful'].includes(op.injury_status)) {
        driver = `${op.name} is listed ${op.injury_status}`;
        tail = ` — ${op.name} is ${op.injury_status}`;
      }

      const why = [{ h: 'The swap', t:
        `${np?.name ?? newPid} projects ${inPts.toFixed(1)} points in week ${week}`
        + (op ? ` against ${outPts.toFixed(1)} for ${op.name}` : ' and the slot is currently empty')
        + ` — a swing of ${gain.toFixed(1)} points, scored under your league's `
        + `settings rather than generic rankings.` }];
      if (driver) why.push({ h: 'Why now', t: driver[0].toUpperCase() + driver.slice(1) + '.' });
      why.push({ h: 'Why this player and not another', t:
        `Your whole roster is assigned to slots at once rather than picked one `
        + `at a time, so flex spots get filled optimally. This is the best legal `
        + `arrangement of the players you have, totalling ${lineup.total.toFixed(1)} `
        + `projected points.` });
      why.push({ h: 'The clock', t:
        `Lineup changes are only worth anything before kickoff. Once the game `
        + `starts this is unrecoverable, which is why it outranks waiver and `
        + `trade moves that still have days of runway.` });

      actions.push({
        kind: 'start_sit',
        headline: `START ${np?.name ?? newPid} at ${slotName}`
                  + (op ? ` over ${op.name}` : ' (empty slot)') + tail,
        detail: `${inPts.toFixed(1)} proj vs ${outPts.toFixed(1)} — +${gain.toFixed(1)} pts in week ${week}`,
        payload: { player_id: newPid, slot: slotName, bench: outPid, gain },
        impact: gain, per_week: gain, weight: gain * URGENCY.lineup,
        horizon: `Before week ${week} kickoff`, reasoning: why,
      });
    }

    // Starters with no viable replacement — a warning, not a swap.
    for (const pid of new Set([...optimalIds, ...currentIds])) {
      if (handled.has(pid) || !currentIds.has(pid)) continue;
      const p = state.players.get(pid);
      if (!p) continue;
      const onBye = !state.projections.hasGame(pid, week);
      const hurt = ['Out', 'IR', 'Doubtful'].includes(p.injury_status);
      if (!onBye && !hurt) continue;
      const label = onBye ? `on BYE in week ${week}` : p.injury_status;
      actions.push({
        kind: 'alert',
        headline: `${p.name} is ${label} and is in your lineup`,
        detail: 'They will score zero. Nothing on your bench beats them outright, '
              + 'so look at the waiver wire.',
        payload: { player_id: pid },
        impact: 0, per_week: 0, weight: 7,
        horizon: `Before week ${week} kickoff`,
        reasoning: [
          { h: 'What happens if you do nothing', t:
            `${p.name} takes a zero in a starting slot. In a ${rules.numTeams}-team `
            + `league that is usually the difference in a weekly matchup.` },
          { h: 'Why no swap is offered', t:
            'No player on your bench projects higher in a slot they are eligible '
            + 'for, so there is no free fix — the answer is on the waiver wire.' },
        ],
      });
    }

    /* ---- waivers ---- */
    onProgress('Ranking the waiver wire…');
    faabLeft = Math.max(0, rules.waiverBudget - me.waiver_budget_used);
    let trending = {};
    try {
      for (const t of (await Sleeper.trending('add', 24, 200)) || [])
        trending[String(t.player_id)] = t.count;
    } catch {}

    waivers = recommendWaivers(state, ros, weekPts, levels, trending, 5);
    drops = dropCandidates(state, ros, 8, weekPts);

    for (const w of waivers) {
      const cost = rules.usesFaab && w.faab_bid
        ? ` — bid $${w.faab_bid} (${w.faab_pct.toFixed(0)}% of your $${faabLeft})`
        : (!rules.usesFaab && me.waiver_position
           ? ` — uses your #${me.waiver_position} waiver priority` : '');
      const perWeek = w.net_gain / weeksLeft;
      actions.push({
        kind: 'waiver',
        headline: `CLAIM ${w.name} (${w.position}-${w.team})${cost}`
                  + (w.drop_id ? `, drop ${w.drop_name}` : ''),
        detail: w.rationale,
        payload: {
          player_id: w.player_id, bid: w.faab_bid, drop_id: w.drop_id,
          net_gain: w.net_gain,
          alternatives: w.alternatives.map(a => ({
            label: `${a.name} (${a.position}-${a.team})`, bid: a.faab_bid,
            net_gain: a.net_gain, drop_name: a.drop_name, detail: a.rationale,
          })),
        },
        impact: w.net_gain, per_week: r2(perWeek),
        weight: perWeek * URGENCY.waiver,
        horizon: `Waivers run ${nextWaiver}`, reasoning: w.reasoning,
      });
    }

    /* ---- trades ---- */
    onProgress('Searching every roster for trades…');
    trades = findTrades(state, ros, levels, { limit: 6 });
    if (!trades.length) {
      const chips = tradeChips(state, ros, levels, 2)
        .map(([pid]) => state.players.name(pid));
      tradeNote = 'No trade currently improves both teams — rosters across the '
        + 'league are still balanced, which is normal early. ';
      if (chips.length) {
        tradeNote += `Your most tradeable surplus is ${chips.join(' and ')}: real `
          + `value your lineup can't start. Shop ${chips.length > 1 ? 'them' : 'him'} `
          + `to a manager thin at that position and re-check after the first `
          + `injuries land.`;
      }
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
          my_gain: t.my_gain, their_gain: t.their_gain,
          alternatives: t.alternatives.map(a => ({
            label: `${a.partner_name}: ${a.summary}`, net_gain: a.my_gain,
            detail: `${a.acceptance} to be accepted · them +${a.their_gain.toFixed(1)}`,
          })),
        },
        impact: t.my_gain, per_week: r2(perWeek),
        weight: perWeek * URGENCY.trade * (acceptFactor[t.acceptance] ?? 0.5),
        horizon: `Trade deadline week ${rules.tradeDeadlineWeek}`,
        reasoning: [
          ...(alsoStarting.length ? [{ h: 'Set your lineup first', t:
            `${alsoStarting.join(' and ')} ${alsoStarting.length > 1 ? 'are' : 'is'} `
            + `in your week ${week} lineup. Trades take days to negotiate and `
            + `lineups lock at kickoff, so start ${alsoStarting.length > 1 ? 'them' : 'him'} `
            + `this week and let the offer run — just replace `
            + `${alsoStarting.length > 1 ? 'them' : 'him'} if it is accepted first.` }] : []),
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
          { h: 'The clock', t:
            `The trade deadline is week ${rules.tradeDeadlineWeek}, `
            + `${Math.max(0, rules.tradeDeadlineWeek - week)} weeks out. There is `
            + `runway here, which is why trades rank below lineup and waiver moves.` },
        ],
      });
    }
  }

  /* ---- alerts from change detection ---- */
  const INFO_WEIGHT = { 'critical:true': 5, 'critical:false': 2.2,
                        'high:true': 1.9, 'high:false': 0.9 };
  for (const c of changes) {
    if (c.severity !== 'critical' && c.severity !== 'high') continue;
    actions.push({
      kind: 'alert', headline: c.headline, detail: c.detail,
      payload: { category: c.category, affects_me: c.affects_me },
      impact: 0, per_week: 0,
      weight: INFO_WEIGHT[`${c.severity}:${Boolean(c.affects_me)}`] ?? 0.8,
      horizon: 'Reacting early is the edge',
      reasoning: [{ h: 'Why you are seeing this', t:
        (c.affects_me ? 'This touches your own roster. '
                      : 'This is league news that may open an opportunity. ')
        + (c.detail || c.headline)
        + ' Detected by comparing the league against your last visit.' }],
    });
  }

  // One scale: points at stake, weighted by how soon the chance to act goes.
  actions.sort((a, b) => b.weight - a.weight);
  actions.forEach((a, i) => {
    a.rank = i + 1;
    const t = tierOf(a.weight);
    a.priority = t.priority;
    a.tier_label = t.label;
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
    if (p) names[pid] = { name: p.name, position: p.position, team: p.team,
                          injury: p.injuryNote };
  };
  currentStarters.forEach(collect);
  lineup?.slots.forEach(s => collect(s.player_id));
  lineup?.bench.forEach(([p]) => collect(p));
  actions.forEach(a => ['player_id', 'bench', 'drop_id'].forEach(k => collect(a.payload?.[k])));
  trades.forEach(t => [...t.send, ...t.receive].forEach(collect));
  drops.forEach(d => collect(d.player_id));

  return {
    generated_at: new Date().toISOString(),
    league_name: rules.name, league_id: rules.leagueId, week,
    my_team: me ? me.label : '(no team linked)',
    record: me ? me.record : '-',
    settings_summary: rules.describe(),
    lineup, current_starters: currentStarters, lineup_gain: lineupGain,
    actions, waivers, drops, trades, changes, trade_note: tradeNote,
    faab_left: faabLeft, next_waiver: nextWaiver, deadlines,
    uses_faab: rules.usesFaab, waiver_type: rules.waiverType,
    waiver_position: me ? me.waiver_position : 0,
    player_names: names,
    _state: state,
  };
}
