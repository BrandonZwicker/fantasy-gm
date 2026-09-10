/* Fantasy GM — league model, scoring and optimisation.
 *
 * Ported from the Python reference implementation in ../gm/. Runs entirely in
 * the browser: Sleeper's API sends `access-control-allow-origin: *`, and its
 * projections payload embeds each player's position, team, opponent and injury
 * status — so the 14.6MB player dump is never needed.
 */

const V1 = 'https://api.sleeper.app/v1';
const ROOT = 'https://api.sleeper.app';
export const LAST_REG_WEEK = 18;

/* ---------------- Sleeper client ---------------- */

const memo = new Map();

async function get(url) {
  if (memo.has(url)) return memo.get(url);
  const p = fetch(url).then(r => {
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Sleeper ${r.status} for ${url.split('?')[0]}`);
    return r.json();
  });
  memo.set(url, p);
  try { return await p; } catch (e) { memo.delete(url); throw e; }
}

export const Sleeper = {
  state: () => get(`${V1}/state/nfl`),
  user: (name) => get(`${V1}/user/${encodeURIComponent(name)}`),
  userLeagues: (uid, season) => get(`${V1}/user/${uid}/leagues/nfl/${season}`),
  league: (id) => get(`${V1}/league/${id}`),
  rosters: (id) => get(`${V1}/league/${id}/rosters`),
  leagueUsers: (id) => get(`${V1}/league/${id}/users`),
  transactions: (id, wk) => get(`${V1}/league/${id}/transactions/${wk}`),
  trending: (kind = 'add', hours = 24, limit = 200) =>
    get(`${V1}/players/nfl/trending/${kind}?lookback_hours=${hours}&limit=${limit}`),
  projections: (season, week) => week == null
    ? get(`${ROOT}/projections/nfl/${season}?season_type=regular`)
    : get(`${ROOT}/projections/nfl/${season}/${week}?season_type=regular`),
};

/* ---------------- roster slots ---------------- */

export const SLOT_ELIGIBILITY = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DEF: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  WRRB_WRT: ['RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
  DL: ['DL', 'DE', 'DT'], LB: ['LB'], DB: ['DB', 'CB', 'S'],
};
const NON_STARTING = new Set(['BN', 'IR', 'TAXI']);

// Sleeper's own default PPR scoring, verified against their published points:
// applied to ACTUAL stats it reproduces `pts_ppr` for 100% of QB, RB, WR and TE
// rows. It lets us separate "value Sleeper's model projects" from "value this
// league's rules award", which are different things.
const REFERENCE_PPR = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, pass_2pt: 2,
  rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
  rec: 1, rec_yd: 0.1, rec_td: 6, rec_2pt: 2,
  fum_lost: -2, fum: 0, fum_rec: 2,
  fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4,
  fgm_50_59: 5, fgm_60p: 6, fgmiss: -1,
  xpm: 1, xpmiss: -1,
  def_td: 6, def_st_td: 6, st_td: 6,
  int: 2, sack: 1, safe: 2, blk_kick: 2,
  ff: 1, def_st_ff: 1, st_ff: 1, def_st_fum_rec: 1, st_fum_rec: 1,
  pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4,
  pts_allow_14_20: 1, pts_allow_21_27: 0, pts_allow_28_34: -1,
  pts_allow_35p: -4,
};
// Below this the reference doesn't describe the player (IDP rows score ~0
// under it), so no residual can be attributed.
const MIN_REFERENCE = 0.5;

// Sleeper's headline projection is a separate model from its own components, so
// trusting it is only worth doing where it is actually more accurate. Measured
// against 2025 results (weeks 1-14), adopting it cuts kicker RMSE from 4.84 to
// 4.70, but pushes quarterbacks from 7.53 to 8.00 — their QB number runs about
// 2.2 points hot. So it is applied to kickers only.
const CALIBRATED_POSITIONS = new Set(['K']);

// Standard deviation of weekly projection error, measured the same way. Used to
// turn a projected edge into the odds it is real.
export const PROJECTION_SD = { QB: 7.5, RB: 6.8, WR: 6.8, TE: 6.0, K: 4.7, DEF: 6.0 };
export const DEFAULT_SD = 6.8;

/** Odds the higher projection is genuinely the better start. */
export function edgeConfidence(edge, posA, posB) {
  const sa = PROJECTION_SD[posA] ?? DEFAULT_SD;
  const sb = PROJECTION_SD[posB] ?? DEFAULT_SD;
  const sd = Math.sqrt(sa * sa + sb * sb) || 1;
  const z = edge / sd;
  // Normal CDF via erf approximation (Abramowitz & Stegun 7.1.26).
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
        - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}
const eligible = (slot) => SLOT_ELIGIBILITY[slot] || [slot];

/* ---------------- league rules ---------------- */

const WAIVER_DAYS = ['Tuesday', 'Wednesday', 'Thursday', 'Friday',
                     'Saturday', 'Sunday', 'Monday'];

function dot(stats, weights) {
  let total = 0;
  for (const k in stats) {
    const w = weights[k];
    if (w) total += stats[k] * w;
  }
  return total;
}

export class LeagueRules {
  constructor(raw) {
    this.raw = raw;
    this.leagueId = String(raw.league_id || '');
    this.name = raw.name || '';
    this.season = String(raw.season || '');
    this.numTeams = raw.total_rosters || 0;
    this.rosterPositions = raw.roster_positions || [];
    this.scoring = raw.scoring_settings || {};
    this.settings = raw.settings || {};
  }

  /** Apply this league's own scoring dictionary to a raw stat line. */
  score(stats) {
    if (!stats) return 0;
    return Math.round(dot(stats, this.scoring) * 100) / 100;
  }

  /** Score a projection, trusting Sleeper's own headline number.
   *
   *  Sleeper's projected `pts_ppr` is a separately modelled figure, not the dot
   *  product of its own projected components: on real stats the two agree
   *  exactly, but on projections quarterbacks diverge by about +2.2 points and
   *  kickers by +1.5, while running backs and receivers sit near zero. Scoring
   *  only the itemised components would understate QB and K value whenever
   *  positions are compared against one another.
   *
   *  So we keep the league's rules for everything the components explain, and
   *  add the part of Sleeper's projection they don't. For a league scored like
   *  standard PPR this reproduces Sleeper's number exactly; for any other
   *  league it carries the same unexplained value onto that league's scale.
   */
  scoreProjection(stats, position) {
    if (!stats) return 0;
    const own = dot(stats, this.scoring);
    if (position != null && !CALIBRATED_POSITIONS.has(position))
      return Math.round(own * 100) / 100;
    const sleeper = stats.pts_ppr;
    if (sleeper == null) return Math.round(own * 100) / 100;
    const reference = dot(stats, REFERENCE_PPR);
    if (reference <= MIN_REFERENCE) return Math.round(own * 100) / 100;
    const cap = Math.max(4, 0.5 * reference);
    const residual = Math.max(-cap, Math.min(cap, sleeper - reference));
    return Math.round((own + residual) * 100) / 100;
  }

  get startingSlots() { return this.rosterPositions.filter(p => !NON_STARTING.has(p)); }
  get benchSlots() { return this.rosterPositions.filter(p => p === 'BN').length; }
  get irSlots() { return this.rosterPositions.filter(p => p === 'IR').length; }
  get taxiSlots() { return this.settings.taxi_slots || 0; }
  get rosterSize() {
    return this.rosterPositions.filter(p => p !== 'IR' && p !== 'TAXI').length;
  }
  slotsOf(s) { return this.rosterPositions.filter(p => p === s).length; }

  get waiverType() {
    const w = this.settings.waiver_type;
    return w === 2 ? 'faab' : w === 1 ? 'rolling' : w === 0 ? 'reverse' : 'none';
  }
  get waiverBudget() { return this.settings.waiver_budget || 0; }
  get usesFaab() { return this.waiverType === 'faab' && this.waiverBudget > 0; }
  get waiverDayOfWeek() { return this.settings.waiver_day_of_week ?? 2; }
  get tradeDeadlineWeek() { return this.settings.trade_deadline || 99; }
  get playoffWeekStart() { return this.settings.playoff_week_start || 15; }
  get playoffTeams() { return this.settings.playoff_teams || 6; }

  get ppr() { return this.scoring.rec || 0; }
  get tePremium() { return Math.round((this.scoring.bonus_rec_te || 0) * 100) / 100; }
  get isSuperflex() {
    return this.startingSlots.includes('SUPER_FLEX') || this.slotsOf('QB') > 1;
  }
  get isIdp() {
    return this.startingSlots.some(s => ['DL', 'LB', 'DB', 'IDP_FLEX'].includes(s));
  }
  get isDynasty() { return (this.settings.type || 0) === 2 || this.taxiSlots > 0; }
  get isKeeper() { return (this.settings.type || 0) === 1; }
  get format() { return this.isDynasty ? 'dynasty' : this.isKeeper ? 'keeper' : 'redraft'; }
  get pprLabel() {
    const p = this.ppr;
    return p === 0 ? 'standard (non-PPR)' : p === 1 ? 'full PPR'
         : p === 0.5 ? 'half PPR' : `${p} PPR`;
  }

  startersNeeded() {
    const c = {};
    for (const s of this.startingSlots) c[s] = (c[s] || 0) + 1;
    return c;
  }

  lineupString() {
    const c = this.startersNeeded();
    const order = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'WRRB_FLEX', 'REC_FLEX',
                   'SUPER_FLEX', 'DL', 'LB', 'DB', 'IDP_FLEX', 'K', 'DEF'];
    const parts = [];
    for (const s of order) if (c[s]) parts.push(c[s] > 1 ? `${c[s]}${s}` : s);
    for (const s in c) if (!order.includes(s)) parts.push(c[s] > 1 ? `${c[s]}${s}` : s);
    return parts.join(' / ');
  }

  describe() {
    const out = [
      `${this.numTeams}-team ${this.format}, ${this.pprLabel}`,
      `Starters: ${this.lineupString()}`,
      `Bench ${this.benchSlots}` + (this.irSlots ? `, IR ${this.irSlots}` : '')
        + (this.taxiSlots ? `, taxi ${this.taxiSlots}` : ''),
    ];
    if (this.isSuperflex) out.push('SUPERFLEX — QBs are dramatically more valuable here');
    if (this.tePremium) out.push(`TE premium (+${this.tePremium}/rec) — TEs gain real value`);
    if (this.isIdp) out.push('IDP league — individual defensive players start');
    if (this.usesFaab) out.push(`FAAB waivers, $${this.waiverBudget} season budget`);
    else if (this.waiverType === 'reverse') out.push('Reverse-standings waivers — priority, no bidding');
    else if (this.waiverType === 'rolling') out.push('Rolling waiver priority — no bidding');
    else out.push('No waivers — free agents are first-come, first-served');
    out.push(`Trade deadline week ${this.tradeDeadlineWeek}, playoffs start week `
           + `${this.playoffWeekStart} (${this.playoffTeams} teams)`);
    return out;
  }

  nextWaiverRun() {
    if (this.waiverType === 'none') return 'No waivers — free agents are first-come';
    const dayName = WAIVER_DAYS[this.waiverDayOfWeek % 7];
    const idx = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4,
                  Friday: 5, Saturday: 6, Sunday: 0 }[dayName];
    const now = new Date();
    let delta = (idx - now.getDay() + 7) % 7;
    if (delta === 0 && now.getHours() >= 3) delta = 7;
    const run = new Date(now);
    run.setDate(now.getDate() + delta);
    run.setHours(3, 0, 0, 0);
    const hrs = (run - now) / 3.6e6;
    return `${dayName} ~3am (${Math.round(hrs)}h away)`;
  }
}

export function positionsInPlay(rules) {
  const s = new Set();
  for (const slot of rules.startingSlots) for (const p of eligible(slot)) s.add(p);
  return s;
}

/* ---------------- lineup optimiser ----------------
 * Flex slots make greedy filling wrong in the general case (REC_FLEX and
 * WRRB_FLEX are not nested), so the assignment is solved exactly with a DP
 * over a bitmask of filled slots. Rosters are small, so this is instant.
 */

export function optimize(rules, candidates, positions, exclude) {
  const ex = exclude || new Set();
  const slots = rules.startingSlots;
  const n = slots.length;

  const pool = [];
  for (const pid in candidates) {
    if (ex.has(pid)) continue;
    const pos = positions[pid];
    if (!pos) continue;
    let mask = 0;
    for (let i = 0; i < n; i++) if (eligible(slots[i]).includes(pos)) mask |= 1 << i;
    if (mask) pool.push([pid, candidates[pid], mask]);
  }
  pool.sort((a, b) => b[1] - a[1]);

  let dp = new Map([[0, [0, []]]]);
  for (const [pid, pts, elig] of pool) {
    const next = new Map(dp);
    for (const [mask, [score, assign]] of dp) {
      const free = elig & ~mask;
      if (!free) continue;
      for (let i = 0; i < n; i++) {
        const bit = 1 << i;
        if (!(free & bit)) continue;
        const nm = mask | bit, ns = score + pts;
        const cur = next.get(nm);
        if (!cur || ns > cur[0]) next.set(nm, [ns, assign.concat([[pid, i]])]);
      }
    }
    dp = next;
  }

  let best = [0, []];
  for (const v of dp.values()) if (v[0] > best[0]) best = v;
  const filled = {};
  for (const [pid, i] of best[1]) filled[i] = pid;

  const outSlots = [];
  for (let i = 0; i < n; i++) {
    const pid = filled[i] || null;
    outSlots.push({ slot: slots[i], player_id: pid,
                    points: Math.round((pid ? candidates[pid] : 0) * 100) / 100 });
  }
  const started = new Set(Object.values(filled));
  const bench = Object.keys(candidates)
    .filter(p => !started.has(p) && !ex.has(p))
    .map(p => [p, Math.round(candidates[p] * 100) / 100])
    .sort((a, b) => b[1] - a[1]);

  return { slots: outSlots, bench, total: Math.round(best[0] * 100) / 100,
           starterIds: () => outSlots.filter(s => s.player_id).map(s => s.player_id) };
}

export const lineupValue = (rules, c, p, ex) => optimize(rules, c, p, ex).total;

/* ---------------- value over replacement ---------------- */

const FLEX_SHARE = { RB: 0.45, WR: 0.45, TE: 0.10, QB: 1.0 };

export function startersByPosition(rules) {
  const counts = {};
  for (const slot of rules.startingSlots) {
    const elig = eligible(slot);
    if (elig.length === 1) {
      counts[elig[0]] = (counts[elig[0]] || 0) + 1;
    } else {
      const w = {}; let tot = 0;
      for (const p of elig) { w[p] = FLEX_SHARE[p] ?? 1 / elig.length; tot += w[p]; }
      for (const p of elig) counts[p] = (counts[p] || 0) + w[p] / (tot || 1);
    }
  }
  return counts;
}

export function replacementLevels(rules, projections, players, benchDepth = 0.5) {
  const perTeam = startersByPosition(rules);
  const byPos = {};
  for (const pid in projections) {
    const p = players.get(pid);
    if (!p || !p.position) continue;
    (byPos[p.position] ||= []).push(projections[pid]);
  }
  const byPosition = {}, rankUsed = {};
  for (const pos in byPos) {
    const need = perTeam[pos] || 0;
    if (need <= 0) continue;
    const rank = Math.max(1, Math.round(rules.numTeams * (need + benchDepth)));
    const list = byPos[pos].sort((a, b) => b - a);
    byPosition[pos] = Math.round(list[Math.min(rank, list.length) - 1] * 100) / 100;
    rankUsed[pos] = rank;
  }
  return { byPosition, rankUsed, of: (p) => byPosition[p] || 0 };
}

export function vor(projections, players, levels) {
  const out = {};
  for (const pid in projections) {
    const p = players.get(pid);
    if (!p || !p.position || !(p.position in levels.byPosition)) continue;
    out[pid] = Math.round((projections[pid] - levels.of(p.position)) * 100) / 100;
  }
  return out;
}

/* ---------------- players, built from projections ---------------- */

/* Injury handling.
 *
 * We deliberately do NOT shade projections for players who might still play.
 * There is no way to calibrate such a multiplier from this data: Sleeper stamps
 * a player's *current* injury status onto every historical projection row, so
 * past rows cannot say what a "Questionable" tag was historically worth.
 *
 * Inventing a discount also breaks the number users check against the app: a
 * 25% haircut turned a 12.7-point projection into 9.5 with nothing on screen
 * explaining it, and that gap was enough to flip start/sit advice.
 *
 * The rule is now factual: a player who will not play is worth zero this week,
 * a player who might play is worth his projection, and the tag is shown.
 */
const OUT_THIS_WEEK = new Set(['Out', 'IR', 'PUP', 'Sus', 'NA', 'DNR', 'Doubtful']);
const LONG_TERM = new Set(['IR', 'PUP', 'NA', 'DNR', 'Sus']);

export class PlayerIndex {
  constructor() { this.byId = new Map(); }

  /** Absorb the player metadata Sleeper embeds in each projection row. */
  absorb(rows) {
    for (const r of rows || []) {
      const pid = String(r.player_id || '');
      if (!pid || this.byId.has(pid)) continue;
      const pl = r.player || {};
      const name = [pl.first_name, pl.last_name].filter(Boolean).join(' ').trim();
      const pos = pl.position || (pl.fantasy_positions || [])[0] || '?';
      this.byId.set(pid, {
        player_id: pid,
        name: name || (pid.length <= 3 ? `${pid} Defense` : pid),
        position: pos,
        team: r.team || pl.team || null,
        injury_status: pl.injury_status || null,
        years_exp: pl.years_exp ?? null,
        availability: OUT_THIS_WEEK.has(pl.injury_status) ? 0 : 1,
        rosMultiplier: LONG_TERM.has(pl.injury_status) ? 0.45 : 1,
        playsThisWeek: !OUT_THIS_WEEK.has(pl.injury_status),
        injuryNote: pl.injury_status || '',
      });
    }
  }

  /** Fold ESPN's injury report onto the index, by player name. */
  attachInjuries(report) {
    this.injuries = report;
    for (const p of this.byId.values()) {
      const hit = report && report.get
        ? report.get(String(p.name || '').toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
            .replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim())
        : null;
      if (hit) {
        p.playProb = hit.probability;
        p.injuryReason = hit.reason;
        p.injuryNote = hit.shortNote || hit.note || '';
        p.injuryStatusNews = hit.status;
        // News supersedes the Sleeper tag, which is coarser and often stale.
        p.availability = hit.probability;
      }
    }
  }

  get(pid) {
    pid = String(pid);
    let p = this.byId.get(pid);
    if (p) return p;
    // Team defenses arrive as bare abbreviations with no projection row.
    if (pid.length <= 3 && /^[A-Za-z]+$/.test(pid)) {
      p = { player_id: pid, name: `${pid.toUpperCase()} Defense`, position: 'DEF',
            team: pid.toUpperCase(), injury_status: null, availability: 1,
            rosMultiplier: 1, playsThisWeek: true, injuryNote: '', years_exp: null };
      this.byId.set(pid, p);
      return p;
    }
    return null;
  }

  name(pid) { return this.get(pid)?.name ?? `player:${pid}`; }
  label(pid) {
    const p = this.get(pid);
    if (!p) return `player:${pid}`;
    const base = `${p.name} (${p.position} - ${p.team || 'FA'})`;
    return p.injuryNote ? `${base} [${p.injuryNote}]` : base;
  }
}

/* ---------------- projections ---------------- */

export class ProjectionBook {
  constructor(rules, players, season) {
    this.rules = rules; this.players = players; this.season = season;
    this.weeks = new Map();      // week -> {pid: {points, team, opponent}}
    this.seasonTotals = null;
    this.byeCache = null;
  }

  async loadWeek(week) {
    if (this.weeks.has(week)) return this.weeks.get(week);
    const rows = await Sleeper.projections(this.season, week);
    this.players.absorb(rows);
    const out = {};
    for (const r of rows || []) {
      const pid = String(r.player_id || '');
      if (!pid) continue;
      out[pid] = { points: this.rules.score(r.stats), team: r.team,
                   opponent: r.opponent, week };
    }
    this.weeks.set(week, out);
    return out;
  }

  async loadSeason() {
    if (this.seasonTotals) return this.seasonTotals;
    const rows = await Sleeper.projections(this.season, null);
    this.players.absorb(rows);
    const out = {};
    for (const r of rows || []) {
      const pid = String(r.player_id || '');
      if (pid) out[pid] = this.rules.scoreProjection(r.stats, (r.player || {}).position);
    }
    this.seasonTotals = out;
    return out;
  }

  points(pid, week, injuryAdjusted = true) {
    const wk = this.weeks.get(week) || {};
    let base = wk[pid]?.points ?? 0;
    if (injuryAdjusted) base *= this.players.get(pid)?.availability ?? 1;
    return Math.round(base * 100) / 100;
  }

  hasGame(pid, week) {
    const wk = this.weeks.get(week) || {};
    return Boolean(wk[pid]?.opponent);
  }

  /** Sum loaded weeks, extrapolating the ones Sleeper hasn't posted yet.
   *
   *  Extrapolation uses each player's own weekly average rather than the
   *  season-long endpoint, which is incomplete for some positions — it returns
   *  `fgm: null` for kickers, counting only extra points, which understates
   *  them by roughly two thirds. Season totals are used only when no weekly
   *  data exists at all.
   */
  restOfSeason(fromWeek, throughWeek) {
    const through = throughWeek || LAST_REG_WEEK;
    const totals = {}, played = {};
    let found = 0;
    for (let w = fromWeek; w <= through; w++) {
      const wk = this.weeks.get(w);
      if (!wk) continue;
      found++;
      for (const pid in wk) {
        totals[pid] = (totals[pid] || 0) + wk[pid].points;
        // Count only weeks with a game, so a bye doesn't drag the average down.
        if (wk[pid].opponent) played[pid] = (played[pid] || 0) + 1;
      }
    }
    const missing = (through - fromWeek + 1) - found;
    if (missing > 0) {
      const season = this.seasonTotals || {};
      const ids = new Set([...Object.keys(totals), ...Object.keys(season)]);
      for (const pid of ids) {
        const games = played[pid] || 0;
        const perWeek = games > 0
          ? totals[pid] / games
          : (season[pid] || 0) / LAST_REG_WEEK;
        totals[pid] = (totals[pid] || 0) + perWeek * missing;
      }
    }
    for (const k in totals) totals[k] = Math.round(totals[k] * 100) / 100;
    return totals;
  }

  /** A team's bye is the week it has no scheduled game. */
  byeWeeks() {
    if (this.byeCache) return this.byeCache;
    const seen = new Map(), all = new Set();
    for (const [w, wk] of this.weeks) {
      const teams = new Set();
      for (const pid in wk) if (wk[pid].team && wk[pid].opponent) teams.add(wk[pid].team);
      seen.set(w, teams);
      for (const t of teams) all.add(t);
    }
    const bye = {};
    for (const [w, teams] of seen) {
      if (teams.size < 20) continue;   // slate not populated yet
      for (const t of all) if (!teams.has(t) && !(t in bye)) bye[t] = w;
    }
    this.byeCache = bye;
    return bye;
  }

  byeFor(pid) {
    const t = this.players.get(pid)?.team;
    return t ? (this.byeWeeks()[t] ?? null) : null;
  }
}

/* ---------------- assembled league state ---------------- */

export class LeagueState {
  /** `source` supplies league/rosters/users directly (used by the bundled
   *  example league); omit it to read a live league from Sleeper. */
  static async load(leagueId, userId, { anonymize = false, source = null } = {}) {
    if (source) {
      const state = await Sleeper.state();
      const ls = new LeagueState(source.league, source.rosters || [],
                                 source.users || [], state, userId, anonymize);
      // Not a real Sleeper league, so league-scoped endpoints would 404.
      ls.isLocal = true;
      return ls;
    }
    const [raw, rosters, users, state] = await Promise.all([
      Sleeper.league(leagueId), Sleeper.rosters(leagueId),
      Sleeper.leagueUsers(leagueId), Sleeper.state(),
    ]);
    if (!raw) throw new Error('League not found');
    return new LeagueState(raw, rosters || [], users || [], state, userId, anonymize);
  }

  constructor(raw, rosters, users, state, userId, anonymize) {
    this.rules = new LeagueRules(raw);
    this.state = state;
    this.season = this.rules.season;
    this.userId = userId;
    this.players = new PlayerIndex();
    this.projections = new ProjectionBook(this.rules, this.players, this.season);

    const byId = {};
    for (const u of users) byId[u.user_id] = u;

    this.teams = {};
    for (const r of rosters) {
      const u = byId[r.owner_id] || {};
      const handle = u.display_name || 'unknown';
      const teamName = (u.metadata || {}).team_name || '';
      const mine = r.owner_id && r.owner_id === userId;
      // On the publicly-linked default view, leaguemates are shown as
      // "Team N" — their Sleeper handles are not ours to publish.
      const shown = (anonymize && !mine)
        ? `Team ${r.roster_id}`
        : (teamName || handle);
      const st = r.settings || {};
      this.teams[r.roster_id] = {
        roster_id: r.roster_id, owner_id: r.owner_id,
        label: shown, handle: anonymize && !mine ? '' : handle,
        players: (r.players || []).map(String),
        starters: (r.starters || []).filter(p => p && p !== '0').map(String),
        reserve: (r.reserve || []).map(String),
        taxi: (r.taxi || []).map(String),
        wins: st.wins || 0, losses: st.losses || 0, ties: st.ties || 0,
        waiver_budget_used: st.waiver_budget_used || 0,
        waiver_position: st.waiver_position || 0,
        record: st.ties ? `${st.wins || 0}-${st.losses || 0}-${st.ties}`
                        : `${st.wins || 0}-${st.losses || 0}`,
        activePlayers() {
          const parked = new Set([...this.reserve, ...this.taxi]);
          return this.players.filter(p => !parked.has(p));
        },
      };
    }

    this.isLocal = false;
    this.myRosterId = null;
    for (const id in this.teams) {
      if (this.teams[id].owner_id === userId) { this.myRosterId = Number(id); break; }
    }
  }

  get me() { return this.myRosterId ? this.teams[this.myRosterId] : null; }
  opponents() {
    return Object.values(this.teams).filter(t => t.roster_id !== this.myRosterId);
  }
  get currentWeek() { return Math.max(1, this.state?.week || 1); }
  get weeksRemaining() {
    return Math.max(0, this.rules.playoffWeekStart - 1 - this.currentWeek + 1);
  }

  ownedIds() {
    const s = new Set();
    for (const id in this.teams) for (const p of this.teams[id].players) s.add(p);
    return s;
  }

  freeAgents(projections) {
    const owned = this.ownedIds();
    const playable = positionsInPlay(this.rules);
    const out = {};
    for (const pid in projections) {
      if (owned.has(pid) || projections[pid] <= 0) continue;
      const p = this.players.get(pid);
      if (!p || !playable.has(p.position)) continue;
      out[pid] = projections[pid];
    }
    return out;
  }

  positionsMap(ids) {
    const out = {};
    for (const pid of (Array.isArray(ids) ? ids : Object.keys(ids))) {
      const p = this.players.get(pid);
      if (p) out[pid] = p.position;
    }
    return out;
  }

  rosterProjection(team, projections) {
    const out = {};
    for (const pid of team.activePlayers()) out[pid] = projections[pid] || 0;
    return out;
  }
}
