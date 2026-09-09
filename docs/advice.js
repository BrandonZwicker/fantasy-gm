/* Fantasy GM — recommendations: waivers, trades, change detection, ranking.
 * Ported from ../gm/{waivers,trades,monitor,recommend}.py.
 */

import {
  LeagueState, ProjectionBook, SLOT_ELIGIBILITY, Sleeper,
  lineupValue, optimize, replacementLevels, vor,
} from './engine.js';

const r2 = (x) => Math.round(x * 100) / 100;
const eligible = (slot) => SLOT_ELIGIBILITY[slot] || [slot];

/* ---------------- tuning ---------------- */

const POSITION_BID_CAP = { K: 0.05, DEF: 0.08 };
const MAX_BID_PCT = 0.6;
// After the top claim is committed, a candidate keeping less than this share of
// its value was competing for the same job — an alternative, not a second move.
const ALTERNATIVE_RETENTION = 0.4;
const MIN_MARGINAL = 0.5;
const DROP_SEARCH_WIDTH = 15;
// Never trade down in asset quality when picking who to cut.
const REPLACEABLE = 0.35;

/* ---------------- drops ---------------- */

function rankDrops(rules, rosterPts, positions, players, startingNow,
                   limit, includeStarters) {
  const base = lineupValue(rules, rosterPts, positions);
  const out = [];
  for (const pid in rosterPts) {
    const without = lineupValue(rules, rosterPts, positions, new Set([pid]));
    const p = players.get(pid);
    out.push({
      player_id: pid, name: p ? players.label(pid) : pid,
      position: p?.position || '?', cost: r2(base - without),
      projection_ros: r2(rosterPts[pid] || 0),
      starts_now: startingNow.has(pid),
    });
  }
  // Never lead with someone you are starting this week.
  out.sort((a, b) => (a.starts_now - b.starts_now) || (a.cost - b.cost)
                     || (a.projection_ros - b.projection_ros));
  if (!includeStarters) {
    const safe = out.filter(d => !d.starts_now);
    if (safe.length) return safe.slice(0, limit);
  }
  return out.slice(0, limit);
}

export function dropCandidates(state, ros, limit = 8, weekPts = null) {
  const me = state.me;
  if (!me) return [];
  const rosterPts = state.rosterProjection(me, ros);
  const positions = state.positionsMap(rosterPts);
  let startingNow = new Set();
  if (weekPts) {
    const wk = {};
    for (const pid of me.activePlayers()) wk[pid] = weekPts[pid] || 0;
    startingNow = new Set(optimize(state.rules, wk, positions).starterIds());
  }
  return rankDrops(state.rules, rosterPts, positions, state.players,
                   startingNow, limit, false);
}

/* ---------------- FAAB sizing ---------------- */

function faabBid(rules, netGain, budgetLeft, weeksLeft, trending,
                 mustAdd, position, fillingEmptySlot) {
  if (!rules.usesFaab || budgetLeft <= 0 || netGain <= 0) return [0, 0];
  const perWeek = netGain / Math.max(1, weeksLeft);
  let pct = Math.min(0.85, (perWeek / 3) * 0.5);
  if (trending > 100000) pct *= 1.6;
  else if (trending > 30000) pct *= 1.3;
  else if (trending > 5000) pct *= 1.1;
  if (mustAdd) pct = Math.max(pct, 0.15);
  // An empty starting slot inflates marginal value (comparing against zero).
  if (fillingEmptySlot) pct = Math.min(pct, 0.12);
  const cap = POSITION_BID_CAP[position] ?? MAX_BID_PCT;
  pct = Math.max(0, Math.min(cap, pct));
  return [Math.max(1, Math.round(budgetLeft * pct)), r2(pct * 100)];
}

/* ---------------- waiver evaluation ---------------- */

function evaluate(state, candidates, rosterPts, positions, weekRoster, weekPts,
                  trending, budgetLeft, weeksLeft, vors, ranks, myPriority) {
  const rules = state.rules;
  const baseLineup = optimize(rules, rosterPts, positions);
  const baseRos = baseLineup.total;
  const baseWeek = lineupValue(rules, weekRoster, positions);
  const rosterFull = Object.keys(rosterPts).length >= rules.rosterSize;

  // Pass 1: marginal value only — cheap, and it says who deserves a drop search.
  const scored = [];
  for (const [pid, rosPts] of candidates) {
    const p = state.players.get(pid);
    if (!p) continue;
    const after = { ...rosterPts, [pid]: rosPts };
    const afterPos = { ...positions, [pid]: p.position };
    const marginal = r2(lineupValue(rules, after, afterPos) - baseRos);
    if (marginal > MIN_MARGINAL) scored.push([pid, rosPts, marginal]);
  }
  scored.sort((a, b) => b[2] - a[2]);
  const shortlist = scored.slice(0, DROP_SEARCH_WIDTH);

  const startingNow = new Set(optimize(rules, weekRoster, positions).starterIds());
  const drops = rankDrops(rules, rosterPts, positions, state.players,
                          startingNow, 12, false);

  const out = {};
  for (const [pid, rosPts, marginal] of shortlist) {
    const p = state.players.get(pid);
    const after = { ...rosterPts, [pid]: rosPts };
    const afterPos = { ...positions, [pid]: p.position };
    const aw = { ...weekRoster, [pid]: weekPts[pid] || 0 };
    const marginalWeek = r2(lineupValue(rules, aw, afterPos) - baseWeek);

    let drop = null, dropCost = 0;
    if (rosterFull && drops.length) {
      // Greedy sequencing will happily cut a top-tier TE to stream a defense
      // once a replacement is claimed. Only cut players worth no more than
      // the one coming in.
      const vIn = vors[pid] || 0;
      let pool = drops.filter(d => d.player_id !== pid
                                   && (vors[d.player_id] || 0) <= Math.max(vIn, 0));
      if (!pool.length) {
        pool = drops.filter(d => d.player_id !== pid)
                    .sort((a, b) => (vors[a.player_id] || 0) - (vors[b.player_id] || 0))
                    .slice(0, 1);
      }
      let best = null;
      for (const d of pool) {
        const trial = { ...after }; delete trial[d.player_id];
        const cost = r2((baseRos + marginal) - lineupValue(rules, trial, afterPos));
        if (!best || cost < best[1]) best = [d, cost];
      }
      if (best) { drop = best[0]; dropCost = best[1]; }
    }

    const net = r2(marginal - dropCost);
    if (net <= 0) continue;

    const tr = trending[pid] || 0;
    const emptySlot = baseLineup.slots.some(
      s => !s.player_id && eligible(s.slot).includes(p.position));
    const [bid, pct] = faabBid(rules, net, budgetLeft, weeksLeft, tr,
                               marginal / weeksLeft > 2, p.position, emptySlot);

    // Where he slots in, and who he pushes out.
    const afterLineup = optimize(rules, after, afterPos);
    const fills = afterLineup.slots.find(s => s.player_id === pid)?.slot || null;
    const before = new Set(baseLineup.starterIds());
    const pushed = afterLineup.starterIds();
    const pushedOut = [...before].filter(x => !pushed.includes(x));
    const pushedName = pushedOut.map(x => state.players.name(x)).join(', ');

    const bits = [];
    if (marginalWeek > 0.5)
      bits.push(`upgrades your week-${state.currentWeek} lineup by ${marginalWeek.toFixed(1)} pts`);
    bits.push(`+${marginal.toFixed(1)} pts rest-of-season to your starting lineup`);
    if (tr > 5000) bits.push(`${tr.toLocaleString()} adds league-wide in 24h — expect competition`);
    if (p.injuryNote) bits.push(`listed ${p.injuryNote}`);
    const bye = state.projections.byeFor(pid);
    if (bye && bye >= state.currentWeek) bits.push(`bye week ${bye}`);

    const why = [];
    why.push({ h: "What he's worth in your league", t:
      `${rosPts.toFixed(1)} projected points from here to the playoffs, scored `
      + `with your league's own settings (${rules.pprLabel}`
      + (rules.tePremium ? `, TE premium +${rules.tePremium}/rec` : '')
      + `). Replacement level at ${p.position} in a ${rules.numTeams}-team league `
      + `like yours is roughly the ${ranks[p.position] ?? '—'}th ${p.position}, so `
      + `he is genuinely above what's freely available.` });

    why.push({ h: 'Where he fits', t: fills
      ? `He starts at ${fills}`
        + (pushedName ? `, pushing ${pushedName} out of your lineup` :
           ', filling a slot nothing on your roster covers')
        + ` — worth ${marginal.toFixed(1)} extra points spread over the `
        + `${weeksLeft} weeks before playoffs, or about `
        + `${(marginal / Math.max(1, weeksLeft)).toFixed(1)} a week.`
      : 'He does not crack your starting lineup outright, but he raises your '
        + 'floor across byes and injuries.' });

    why.push({ h: 'Why this is measured as a gain', t:
      `Ranked by what he adds to your STARTING lineup (+${marginal.toFixed(1)}), `
      + `not by his raw projection. A player who never starts is worth nothing `
      + `to you no matter how good his ranking looks — that is why bigger names `
      + `below him on the wire are not recommended.` });

    if (drop) {
      why.push({ h: `Why drop ${drop.name}`, t:
        `Cutting him costs you ${drop.cost.toFixed(1)} points of lineup value`
        + (drop.cost < 0.5 ? ' — nothing, because someone behind him absorbs the role' : '')
        + `. He is the cheapest legal cut that isn't in your week-${state.currentWeek} `
        + `lineup, and he is not worth more than the player coming in. `
        + `Net gain after the swap: ${net.toFixed(1)}.` });
    }

    why.push(rules.usesFaab
      ? { h: `Why $${bid}`, t:
          `${net.toFixed(1)} points over ${weeksLeft} remaining weeks is `
          + `${(net / Math.max(1, weeksLeft)).toFixed(1)} per week. That scales to `
          + `${pct.toFixed(0)}% of your $${budgetLeft} remaining budget`
          + (tr > 5000 ? `, bumped up because ${tr.toLocaleString()} managers added `
             + `him in the last 24 hours and you will be outbid at a token price.` : '.')
          + (POSITION_BID_CAP[p.position]
             ? ` Capped low because ${p.position} is a streaming position — next `
               + `week's option is nearly as good.` : '') }
      : { h: 'What the claim costs you', t:
          `This league uses ${rules.waiverType} waiver priority, not FAAB, so there `
          + `is nothing to bid. Making the claim spends your #${myPriority} priority `
          + `and sends you to the back of the order — worth it here, but it is the `
          + `real price.` });

    const risks = [];
    if (p.injuryNote) risks.push(`he is listed ${p.injuryNote}`);
    if (bye && bye >= state.currentWeek) risks.push(`his bye is week ${bye}`);
    if (tr > 30000) risks.push(`${tr.toLocaleString()} adds league-wide in 24h means real competition`);
    if (marginalWeek < 0.5) risks.push('he does not help your lineup this week — this is a rest-of-season play');
    if (risks.length) {
      why.push({ h: 'What could go wrong', t:
        risks[0][0].toUpperCase() + risks[0].slice(1)
        + (risks.length > 1 ? '; ' + risks.slice(1).join('; ') : '') + '.' });
    }

    out[pid] = {
      player_id: pid, name: p.name, position: p.position, team: p.team,
      projection_ros: r2(rosPts), marginal_ros: marginal, marginal_week: marginalWeek,
      drop_id: drop?.player_id ?? null, drop_name: drop?.name ?? '',
      drop_cost: dropCost, net_gain: net, faab_bid: bid, faab_pct: pct,
      trending_adds: tr, rationale: bits.join('; '), reasoning: why,
      alternatives: [],
    };
  }
  return out;
}

/* ---------------- waiver recommendations ----------------
 * Greedy with re-evaluation: commit the best claim, re-score against the
 * resulting roster. Candidates whose value survives are separate moves;
 * those whose value collapses were after the same job.
 */

export function recommendWaivers(state, ros, weekPts, levels, trending, limit = 5, pool = 120) {
  const me = state.me;
  if (!me) return [];
  const rules = state.rules;

  const rosterPts = { ...state.rosterProjection(me, ros) };
  const positions = { ...state.positionsMap(rosterPts) };
  const weekRoster = {};
  for (const pid of me.activePlayers()) weekRoster[pid] = weekPts[pid] || 0;

  const budgetLeft = Math.max(0, rules.waiverBudget - me.waiver_budget_used);
  const weeksLeft = Math.max(1, state.weeksRemaining);
  const vors = vor(ros, state.players, levels);

  let remaining = Object.entries(state.freeAgents(ros))
    .sort((a, b) => b[1] - a[1]).slice(0, pool);

  const moves = [];
  for (let round = 0; round < limit; round++) {
    const scored = evaluate(state, remaining, rosterPts, positions, weekRoster,
                            weekPts, trending, budgetLeft, weeksLeft, vors,
                            levels.rankUsed, me.waiver_position);
    const vals = Object.values(scored);
    if (!vals.length) break;
    const best = vals.reduce((a, b) => (b.net_gain > a.net_gain ? b : a));

    // Commit it, then see what survives.
    rosterPts[best.player_id] = best.projection_ros;
    positions[best.player_id] = best.position;
    weekRoster[best.player_id] = weekPts[best.player_id] || 0;
    if (best.drop_id) { delete rosterPts[best.drop_id]; delete weekRoster[best.drop_id]; }
    remaining = remaining.filter(([p]) => p !== best.player_id);

    const after = evaluate(state, remaining, rosterPts, positions, weekRoster,
                           weekPts, trending, budgetLeft, weeksLeft, vors,
                           levels.rankUsed, me.waiver_position);

    const alts = [];
    for (const pid in scored) {
      if (pid === best.player_id) continue;
      const beforeT = scored[pid], still = after[pid];
      const kept = (still && beforeT.net_gain > 0) ? still.net_gain / beforeT.net_gain : 0;
      if (kept < ALTERNATIVE_RETENTION) alts.push(beforeT);
    }
    alts.sort((a, b) => b.net_gain - a.net_gain);
    best.alternatives = alts.slice(0, 4);

    const consumed = new Set(alts.map(a => a.player_id));
    remaining = remaining.filter(([p]) => !consumed.has(p));
    moves.push(best);
    if (!remaining.length) break;
  }
  return moves;
}

/* ---------------- trades ---------------- */

const ACCEPTANCE_BANDS = [[0.90, 'likely'], [0.72, 'possible'],
                          [0.55, 'long shot'], [0, 'unlikely']];
const acceptance = (ratio) =>
  (ACCEPTANCE_BANDS.find(([t]) => ratio >= t) || [0, 'unlikely'])[1];
const ACCEPT_WEIGHT = { likely: 1, possible: 0.75, 'long shot': 0.45, unlikely: 0 };

function profile(state, team, ros) {
  const prof = {};
  for (const pid of team.activePlayers()) {
    const p = state.players.get(pid);
    if (p) (prof[p.position] ||= []).push(ros[pid] || 0);
  }
  for (const k in prof) prof[k].sort((a, b) => b - a);
  return prof;
}

const swapRoster = (pts, out, inn, src) => {
  const n = { ...pts };
  for (const p of out) delete n[p];
  for (const p of inn) n[p] = src[p] || 0;
  return n;
};

export function tradeChips(state, ros, levels, limit = 3) {
  const me = state.me;
  if (!me) return [];
  const myPts = state.rosterProjection(me, ros);
  const positions = state.positionsMap(myPts);
  const base = lineupValue(state.rules, myPts, positions);
  const vors = vor(ros, state.players, levels);
  const out = [];
  for (const pid in myPts) {
    const value = vors[pid] || 0;
    if (value <= 0) continue;   // nobody trades for a below-replacement player
    const cost = base - lineupValue(state.rules, myPts, positions, new Set([pid]));
    if (cost > REPLACEABLE * value) continue;   // you would feel this one
    out.push([pid, r2(value)]);
  }
  out.sort((a, b) => b[1] - a[1]);
  return out.slice(0, limit);
}

export function findTrades(state, ros, levels, {
  limit = 6, maxSend = 2, minMyGain = 3, minTheirGain = 1 } = {}) {
  const me = state.me;
  if (!me) return [];
  const rules = state.rules;
  const vors = vor(ros, state.players, levels);
  const myPts = state.rosterProjection(me, ros);
  const teamValue = (pts) => lineupValue(rules, pts, state.positionsMap(pts));
  const myBase = teamValue(myPts);

  const myRanked = Object.entries(myPts).sort((a, b) => b[1] - a[1]);
  const myCandidates = myRanked.slice(1).map(([p]) => p).slice(0, 12);  // keep your best
  const myProf = profile(state, me, ros);

  const ideas = [];
  for (const opp of state.opponents()) {
    const theirPts = state.rosterProjection(opp, ros);
    if (!Object.keys(theirPts).length) continue;
    const theirBase = teamValue(theirPts);
    const theirTargets = Object.entries(theirPts)
      .sort((a, b) => b[1] - a[1]).slice(0, 12).map(([p]) => p);
    const theirProf = profile(state, opp, ros);

    const combos = [];
    for (const get of theirTargets) {
      for (const s of myCandidates) combos.push([[s], [get]]);
      if (maxSend >= 2) {
        for (let i = 0; i < myCandidates.length; i++)
          for (let j = i + 1; j < myCandidates.length; j++)
            combos.push([[myCandidates[i], myCandidates[j]], [get]]);
      }
    }

    for (const [send, get] of combos) {
      const mineAfter = swapRoster(myPts, send, get, ros);
      const myGain = r2(teamValue(mineAfter) - myBase);
      if (myGain < minMyGain) continue;

      const theirsAfter = swapRoster(theirPts, get, send, ros);
      const theirGain = r2(teamValue(theirsAfter) - theirBase);
      if (theirGain < minTheirGain) continue;

      // Roster-size legality: a 2-for-1 leaves them a man over.
      if (send.length !== get.length
          && Object.keys(theirPts).length - get.length + send.length > rules.rosterSize)
        continue;

      // Perceived-value check: what you give up vs what you ask for.
      const vSend = send.reduce((s, p) => s + Math.max(0, vors[p] || 0), 0);
      const vGet = get.reduce((s, p) => s + Math.max(0, vors[p] || 0), 0);
      const ratio = vGet > 0 ? r2(vSend / vGet) : 2;
      const accept = acceptance(ratio);
      if (accept === 'unlikely') continue;   // don't burn credibility

      const total = myGain + theirGain;
      const fairness = total ? r2(1 - Math.abs(myGain - theirGain) / total) : 0;

      const why = [];
      for (const gp of new Set(get.map(p => state.players.get(p)?.position))) {
        if (gp) why.push(`they carry ${(theirProf[gp] || []).length} ${gp}s and can absorb the loss`);
      }
      for (const sp of new Set(send.map(p => state.players.get(p)?.position))) {
        if (sp && (myProf[sp] || []).length >= 3)
          why.push(`you have ${myProf[sp].length} ${sp}s — surplus you can't start`);
      }
      why.push(`your lineup +${myGain.toFixed(1)}, theirs +${theirGain.toFixed(1)} rest-of-season`);

      ideas.push({
        partner_roster_id: opp.roster_id, partner_name: opp.label,
        send, receive: get,
        send_names: send.map(p => state.players.name(p)),
        receive_names: get.map(p => state.players.name(p)),
        my_gain: myGain, their_gain: theirGain, fairness,
        value_ratio: ratio, acceptance: accept,
        rationale: [...new Set(why)].join('; '),
        alternatives: [],
        get summary() {
          return `Send ${this.send_names.join(', ')} → Get ${this.receive_names.join(', ')}`;
        },
      });
    }
  }

  const rank = (t) => -(t.my_gain * (ACCEPT_WEIGHT[t.acceptance] ?? 0.3) + t.their_gain * 0.03);
  ideas.sort((a, b) => rank(a) - rank(b));

  // You can only send a given player once, so offers built on the same
  // outgoing piece are alternatives, not separate moves.
  const bySend = new Map();
  for (const i of ideas) {
    const k = [...i.send].sort().join('|');
    if (!bySend.has(k)) bySend.set(k, []);
    bySend.get(k).push(i);
  }
  const grouped = [];
  for (const group of bySend.values()) {
    group[0].alternatives = group.slice(1, 4);
    grouped.push(group[0]);
  }
  grouped.sort((a, b) => rank(a) - rank(b));

  // The shortlist has to be executable as a whole, not just pairwise valid.
  // Two separately sensible offers can send both your quarterbacks and leave
  // you unable to field a lineup, so each is applied to a running roster and
  // rejected if it breaks legality.
  const seenRecv = new Set(), sentAll = new Set();
  let sim = { ...myPts };
  const final = [];
  for (const i of grouped) {
    if (i.receive.some(p => seenRecv.has(p))) continue;
    if (i.send.some(p => sentAll.has(p))) continue;
    const after = swapRoster(sim, i.send, i.receive, ros);
    const lu = optimize(rules, after, state.positionsMap(after));
    if (lu.slots.some(s => !s.player_id)) continue;   // would leave a slot empty
    sim = after;
    i.send.forEach(p => sentAll.add(p));
    i.receive.forEach(p => seenRecv.add(p));
    final.push(i);
    if (final.length >= limit) break;
  }
  return final;
}

/* ---------------- change detection (localStorage snapshots) ---------------- */

const SNAP_KEY = (lid, kind) => `fgm.snap.${lid}.${kind}`;
const readSnap = (lid, kind) => {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY(lid, kind)) || 'null'); }
  catch { return null; }
};
const writeSnap = (lid, kind, v) => {
  try { localStorage.setItem(SNAP_KEY(lid, kind), JSON.stringify(v)); } catch {}
};

export async function detectChanges(state) {
  const lid = state.rules.leagueId;
  const changes = [];
  const me = state.me;
  const mine = new Set(me ? me.players : []);

  // Roster movement across the league.
  const current = {};
  for (const id in state.teams) current[id] = [...state.teams[id].players].sort();
  const prev = readSnap(lid, 'rosters');
  if (prev) {
    for (const id in current) {
      const before = new Set(prev[id] || []);
      const after = new Set(current[id]);
      const team = state.teams[id];
      const isMine = Number(id) === state.myRosterId;
      for (const pid of after) if (!before.has(pid)) {
        changes.push({ category: 'roster', severity: isMine ? 'high' : 'medium',
          headline: `${team.label} added ${state.players.name(pid)}`,
          detail: '', affects_me: isMine });
      }
      for (const pid of before) if (!after.has(pid)) {
        const p = state.players.get(pid);
        changes.push({ category: 'roster',
          severity: p && ['RB', 'WR', 'TE', 'QB'].includes(p.position) ? 'high' : 'low',
          headline: `${team.label} dropped ${state.players.name(pid)}`,
          detail: 'Now a free agent', affects_me: isMine });
      }
    }
  }
  writeSnap(lid, 'rosters', current);

  // Injury / status changes on every rostered player.
  const watch = new Set();
  for (const id in state.teams) for (const p of state.teams[id].players) watch.add(p);
  const inj = {};
  for (const pid of watch) inj[pid] = state.players.get(pid)?.injury_status || '';
  const prevInj = readSnap(lid, 'injuries');
  if (prevInj) {
    const ALERT = new Set(['Out', 'IR', 'Doubtful', 'PUP', 'Sus', 'NA', 'Questionable']);
    for (const pid in inj) {
      const before = prevInj[pid] ?? '', now = inj[pid];
      if (now === before) continue;
      const p = state.players.get(pid);
      if (!p) continue;
      const isMine = mine.has(pid);
      if (ALERT.has(now)) {
        changes.push({ category: 'injury',
          severity: isMine && ['Out', 'IR', 'Doubtful'].includes(now) ? 'critical'
                  : isMine ? 'high' : 'medium',
          headline: `${p.name} is now ${now}${isMine ? ' (YOUR PLAYER)' : ''}`,
          detail: `Changed from '${before || 'healthy'}' to '${now}'`,
          affects_me: isMine });
      } else if (ALERT.has(before) && !now) {
        changes.push({ category: 'injury', severity: isMine ? 'high' : 'low',
          headline: `${p.name} is cleared (was ${before})`, detail: '',
          affects_me: isMine });
      }
    }
  }
  writeSnap(lid, 'injuries', inj);

  // Completed league transactions. Skipped for the bundled example league,
  // whose id does not exist on Sleeper.
  try {
    const txs = state.isLocal ? [] : await Sleeper.transactions(lid, state.currentWeek);
    const seenTx = new Set(readSnap(lid, 'tx') || []);
    const nowTx = [];
    for (const tx of txs || []) {
      if (tx.status !== 'complete') continue;
      nowTx.push(tx.transaction_id);
      if (seenTx.has(tx.transaction_id)) continue;
      const rids = tx.roster_ids || [];
      const names = rids.map(r => state.teams[r]?.label).filter(Boolean);
      if (tx.type === 'trade') {
        changes.push({ category: 'trade', severity: 'high',
          headline: `Trade completed: ${names.join(' ↔ ')}`,
          detail: Object.keys(tx.adds || {}).map(p => state.players.name(p)).join(', '),
          affects_me: rids.includes(state.myRosterId) });
      } else if (tx.adds) {
        const bid = (tx.settings || {}).waiver_bid;
        for (const pid in tx.adds) {
          changes.push({ category: 'waiver', severity: 'low',
            headline: `${names[0] || '?'} claimed ${state.players.name(pid)}`
                      + (bid ? ` for $${bid}` : ''),
            detail: tx.type, affects_me: rids.includes(state.myRosterId) });
        }
      }
    }
    writeSnap(lid, 'tx', nowTx);
  } catch { /* transactions are optional context */ }

  // League-wide add spikes on players you could still get.
  try {
    const owned = state.ownedIds();
    const trend = await Sleeper.trending('add', 24, 25);
    for (const t of (trend || []).slice(0, 8)) {
      const pid = String(t.player_id);
      if (owned.has(pid) || t.count < 20000) continue;
      const p = state.players.get(pid);
      if (!p) continue;
      changes.push({ category: 'trending', severity: 'medium',
        headline: `${p.name} is being added everywhere (${t.count.toLocaleString()} adds/24h)`,
        detail: 'Free agent in your league', affects_me: false });
    }
  } catch {}

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  changes.sort((a, b) => (order[a.severity] - order[b.severity])
                       || (b.affects_me - a.affects_me));
  return changes;
}
