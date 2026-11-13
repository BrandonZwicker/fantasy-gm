/* Fantasy Football GM — UI. Everything runs client-side; there is no server. */

import { Sleeper } from './engine.js';
import { assemble, buildReport, refine } from './report.js';
import { EXAMPLE, PLATFORMS } from './providers.js';
import { EVENT_KINDS, LEAD_TIMES, downloadICS } from './reminders.js';
import { buildCase, buildKeyPoints, buildSVG, svgToPng } from './proposal.js';
import { pronouns } from './engine.js';
import { analyzeOffer } from './advice.js';

const KEY = 'fantasy-gm.session';
const PREF = 'fantasy-gm.prefs';
const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k)) || null; } catch { return null; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const drop = (k) => { try { localStorage.removeItem(k); } catch {} };

let SESSION = readJSON(KEY);
let PREFS = { mode: 'tabs', tab: 'overview', tradeView: 'sent',
              remind: ['waivers', 'kickoff'], lead: '3h',
              ...(readJSON(PREF) || {}) };
let REPORT = null;
let STATE = null;
// The offer being analysed on the Trades tab. Survives re-renders.
let OFFER = { partner: null, give: [], get: [], result: null };

const node = (h) => { const d = document.createElement('div'); d.innerHTML = h.trim(); return d.firstChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const app = () => document.getElementById('app');
const savePrefs = () => writeJSON(PREF, PREFS);

const pinfo = (id) => REPORT?.player_names?.[id] || { name: id, position: '', team: '', injury: '' };
function who(id) {
  if (!id) return '<span class="vacant">— empty —</span>';
  const p = pinfo(id);
  const odds = (p.play_prob != null && p.play_prob < 0.95)
    ? `<span class="odds" title="${esc(p.injury_note || p.injury_reason || '')}">${Math.round(p.play_prob * 100)}% to play</span>`
    : '';
  return `<b>${esc(p.name)}</b><span>${esc(p.position)}${p.team ? ' · ' + esc(p.team) : ''}</span>`
       + (p.injury ? `<span class="hurt">${esc(p.injury)}</span>` : '') + odds;
}
const plain = (id) => esc(pinfo(id).name);

function hint(msg) {
  const h = document.getElementById('hint');
  if (!h) return;
  h.textContent = msg;
  h.classList.add('on');
  setTimeout(() => h.classList.remove('on'), 4000);
}

/* ================= sign in ================= */

function renderGate(msg) {
  app().innerHTML = '';
  const g = node(`<div class="gate">
    <div class="mark">Fantasy football <em>GM</em></div>
    <p class="lede">Reads your fantasy league end to end and tells you exactly what
      to do about it — lineup changes, waiver claims, trades — scored under your
      league's own settings.</p>

    ${msg ? `<div class="warn">${esc(msg)}</div>` : ''}

    ${SESSION ? `<div class="opt-row resume" id="resume"><div>
        <b>Continue with ${esc(SESSION.kind === 'example' ? 'the example league'
                                : (SESSION.league_name || 'your league').trim())}</b>
        <div class="s">picked up where you left off</div></div>
      <span class="arw">→</span></div>` : ''}

    <input class="field" id="u" placeholder="Sleeper username" autocomplete="off" spellcheck="false">
    <button class="btn solid" id="go">Find my leagues</button>

    <div class="rule">or paste a league ID</div>
    <input class="field" id="lid" placeholder="League ID" autocomplete="off">
    <button class="btn" id="golid">Load that league</button>

    <div id="out" style="margin-top:16px"></div>

    <div class="rule">or</div>
    <div class="try">
      <div class="try-in">
        <div>
          <b>Try it with an example league</b>
          <div class="s">A full 12-team half-PPR league with real players and live
            projections. No sign-in.</div>
        </div>
        <button class="btn solid" id="demo">See it working →</button>
      </div>
    </div>
  </div>`);
  app().appendChild(g);

  const inp = g.querySelector('#u'), out = g.querySelector('#out');
  const go = g.querySelector('#go'), lid = g.querySelector('#lid');
  g.querySelector('#demo').onclick = () => startExample();
  const resume = g.querySelector('#resume');
  if (resume) resume.onclick = () => run();
  inp.focus();

  const choose = (username, user_id, l) => {
    SESSION = { kind: 'sleeper', username, user_id,
                league_id: l.league_id, league_name: l.name };
    writeJSON(KEY, SESSION);
    run();
  };

  const byUser = async () => {
    const u = inp.value.trim(); if (!u) return;
    go.disabled = true; out.innerHTML = '<p class="lede">Searching…</p>';
    try {
      const { userId, season, leagues } = await PLATFORMS.sleeper.findLeagues(u, Sleeper);
      if (!leagues.length) {
        out.innerHTML = `<div class="warn">No ${esc(season)} leagues for “${esc(u)}”.
          Try a league ID instead.</div>`;
      } else {
        out.innerHTML = '<div class="rule">choose a league</div>';
        for (const l of leagues) {
          const r = node(`<div class="opt-row"><div><b>${esc(l.name)}</b>
            <div class="s">${l.teams} teams · ${esc(season)}</div></div>
            <span class="arw">→</span></div>`);
          r.onclick = () => choose(u, userId, l);
          out.appendChild(r);
        }
      }
    } catch (e) { out.innerHTML = `<div class="warn">${esc(e.message)}</div>`; }
    go.disabled = false;
  };

  const byLeague = async () => {
    const id = lid.value.trim(); if (!id) return;
    out.innerHTML = '<p class="lede">Loading league…</p>';
    try {
      const [lg, users, rosters] = await Promise.all([
        Sleeper.league(id), Sleeper.leagueUsers(id), Sleeper.rosters(id)]);
      if (!lg) throw new Error('League not found');
      const byOwner = {};
      for (const r of rosters || []) byOwner[r.owner_id] = r.roster_id;
      out.innerHTML = `<div class="rule">which team is yours in ${esc(lg.name)}?</div>`;
      for (const m of (users || []).sort((a, b) => (byOwner[a.user_id] || 99) - (byOwner[b.user_id] || 99))) {
        const label = (m.metadata || {}).team_name || m.display_name;
        const r = node(`<div class="opt-row"><div><b>${esc(label)}</b>
          <div class="s">@${esc(m.display_name)}${byOwner[m.user_id] ? ' · roster ' + byOwner[m.user_id] : ''}</div></div>
          <span class="arw">→</span></div>`);
        r.onclick = () => choose(m.display_name, m.user_id, { league_id: id, name: lg.name });
        out.appendChild(r);
      }
    } catch (e) { out.innerHTML = `<div class="warn">${esc(e.message)}</div>`; }
  };

  go.onclick = byUser;
  inp.onkeydown = e => { if (e.key === 'Enter') byUser(); };
  g.querySelector('#golid').onclick = byLeague;
  lid.onkeydown = e => { if (e.key === 'Enter') byLeague(); };
}

/* ================= dashboard pieces ================= */

// What kind of step each item is, in the words you would use in the app.
const STAGE_LABEL = { roster: 'Roster', start_sit: 'Lineup', waiver: 'Pickup',
                      alert: 'Heads up', trade: 'Offer' };

function actionHTML(a, { showAlts = true } = {}) {
  const alts = showAlts ? (a.payload?.alternatives || []) : [];
  const why = a.reasoning || [];
  const dl = a.deadline;
  // An injury-driven swap is a different kind of decision from a projection
  // edge — it can flip on news — so it says so and points at the re-check.
  const whyLabel = a.injury_driven
    ? (dl && !dl.locked
        ? `More info, re-check by ${new Date(dl.check_by).toLocaleString(undefined,
            { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
        : 'More info, this one hinges on health')
    : 'More info';
  const whyHTML = why.length ? `
    <details class="${a.injury_driven ? 'health' : ''}"><summary>${esc(whyLabel)}</summary>
      <div class="rz">${why.map(s => `<div class="st"><h5>${esc(s.h)}</h5>
        <p>${esc(s.t)}</p></div>`).join('')}</div></details>` : '';
  const altHTML = alts.length ? `
    <details><summary>${alts.length} alternative${alts.length > 1 ? 's' : ''} — only one of these can happen</summary>
      <div class="rz">${alts.map(o => `<div class="st"><h5>${esc(o.label)}</h5>
        <p>${o.bid ? '$' + o.bid + ' · ' : ''}worth ${(+o.net_gain).toFixed(1)} pts${
          o.drop_name ? ' · drop ' + esc(o.drop_name) : ''}${
          o.detail ? ' — ' + esc(o.detail) : ''}</p></div>`).join('')}</div></details>` : '';
  // Say which horizon a number covers — a single week and a whole rest-of-season
  // are not the same unit and shouldn't look alike.
  const horizonWord = a.unit === 'week' ? 'this week' : 'rest of season';
  const pts = a.impact > 0.05
    ? `<span class="pillx pts">+${a.impact.toFixed(1)} pts ${horizonWord}</span>` : '';
  const rate = (a.per_week > 0.05 && a.unit !== 'week')
    ? `<span class="pillx">${a.per_week.toFixed(1)} / week</span>` : '';
  const conf = a.confidence != null
    ? `<span class="pillx conf">${Math.round(a.confidence * 100)}% likely right</span>` : '';
  const check = dl && !dl.locked
    ? `<span class="pillx check">final check ${new Date(dl.check_by)
        .toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>`
    : dl && dl.locked ? '<span class="pillx locked">window closed</span>' : '';
  return `<div class="act">
    <div class="line">
      <span class="rk ${a.priority === 1 ? 'urgent' : a.rank <= 2 ? 'lead' : ''}"
            title="${a.priority === 1 ? 'High priority' : ''}">${a.rank}</span>
      <div class="actbody"><div class="stagerow"><span class="chip stage ${esc(a.kind)}">${esc(STAGE_LABEL[a.kind] || '')}</span>
        ${a.injury_driven ? '<span class="chip injury">Injury call</span>' : ''}</div>
        <h4>${esc(a.headline)}</h4>
        ${a.detail ? `<p>${esc(a.detail)}</p>` : ''}</div>
    </div>
    <div class="meta-row">${pts}${rate}${conf}${check}
      ${a.horizon ? `<span class="pillx when">${esc(a.horizon)}</span>` : ''}</div>
    ${(whyHTML || altHTML) ? `<div class="disc">${whyHTML}${altHTML}</div>` : ''}
  </div>`;
}

const CARDS = {
  hero(r) {
    const floor = r.thresholds?.startSit ?? 2.5;
    const up = r.lineup_gain >= floor;
    // Every game has kicked off, so the lineup is not "correct", it is settled.
    if (r.lineup_locked) {
      return `<div class="hero">
        <div class="fig flat">🔒</div>
        <div class="say">
          <h2>Week ${r.week} is locked in</h2>
          <p>Every one of your starters has already kicked off, so there is
             nothing left to change. Waivers and trades below still matter for
             next week.</p>
        </div>
        <div class="meta">
          <div><div class="k">Record</div><div class="v">${esc(r.record)}</div></div>
          <div><div class="k">Projected</div><div class="v">${r.lineup ? r.lineup.total.toFixed(1) : '—'}</div></div>
          <div><div class="k">${r.uses_faab ? 'FAAB left' : 'Priority'}</div>
            <div class="v">${r.uses_faab ? '$' + r.faab_left : '#' + (r.waiver_position || '—')}</div></div>
        </div></div>`;
    }
    // A gain that exists but sits under the threshold is noise, not an
    // opportunity — say so rather than dangling a number we won't act on.
    const marginal = !up && (r.lineup_unclaimed ?? 0) > 0.1;
    return `<div class="hero">
      <div class="fig ${up ? '' : 'flat'}">${up ? '+' + r.lineup_gain.toFixed(1) : '✓'}</div>
      <div class="say">
        <h2>${r.roster_fix?.over_by > 0 ? `You are ${r.roster_fix.over_by} over the roster limit`
             : up ? 'Points left on your bench'
                 : marginal ? 'Lineup is good enough'
                 : 'Your lineup is set correctly'}</h2>
        <p>${r.roster_fix?.over_by > 0 ? `Sleeper won't process an add, claim or trade until that's fixed. Step 1 below sorts it${up ? `, and the lineup steps after it add ${r.lineup_gain.toFixed(1)} projected points` : ''}.`
             : up ? `Fixing your week ${r.week} lineup is worth ${r.lineup_gain.toFixed(1)} more projected points.`
             : marginal ? `Another ${r.lineup_unclaimed.toFixed(1)} points exist on paper, but they are inside the projection noise, so they are not worth the move.`
             : `Nothing to change for week ${r.week}. The optimal starters are already in.`}${
             r.movable_slots && r.movable_slots < (r.lineup?.slots.length || 0)
               ? ` ${r.movable_slots} of ${r.lineup.slots.length} slots are still movable, the rest have kicked off.`
               : ''}</p>
      </div>
      <div class="meta">
        <div><div class="k">Record</div><div class="v">${esc(r.record)}</div></div>
        <div><div class="k">Projected</div><div class="v">${r.lineup ? r.lineup.total.toFixed(1) : '—'}</div></div>
        <div><div class="k">${r.uses_faab ? 'FAAB left' : 'Priority'}</div>
          <div class="v">${r.uses_faab ? '$' + r.faab_left : '#' + (r.waiver_position || '—')}</div></div>
      </div></div>`;
  },

  actions(r) {
    // One list, in the order you do it. Each step already assumes the ones
    // above it are done, so there is nothing to choose between here.
    const groupsHTML = `<div class="plan">${r.actions.map(a =>
      actionHTML(a, { showAlts: false })).join('')}</div>`;

    const held = r.held_back
      ? `<details class="heldback"><summary>${r.held_back} move${r.held_back > 1 ? 's' : ''} too small to be worth making</summary>
           <div class="rz">${(r.held_back_detail || []).map(h => `<div class="st">
             <h5>${esc(h.headline)}</h5><p>worth ${(+h.impact).toFixed(1)} pts</p></div>`).join('')}
           <div class="st"><p>Weekly projections miss by about 6.8 points, so an
             edge this small is close to a coin flip — as likely to cost you as
             to gain you.</p></div></div></details>`
      : '';
    const body = r.actions.length ? groupsHTML + held
      : `<div class="allclear"><span class="big">All clear</span>
         No moves worth making right now. Check back after the next games.</div>${held}`;
    return `<div class="card"><header><h3>The decision room</h3>
      <span class="note">${r.actions.length} step${r.actions.length === 1 ? '' : 's'} · do them in this order, each one assumes the last is done</span></header>
      <div class="in">${body}</div></div>`;
  },

  lineup(r) {
    // This table shows the lineup we are RECOMMENDING, not the one currently
    // set in Sleeper. Labelling it "Week N lineup" made it look like stale
    // data whenever it differed, which is exactly when it matters most.
    const current = new Set((r.current_starters || []).filter(p => p && p !== '0'));
    const proposed = new Set(r.lineup?.slots.map(s => s.player_id).filter(Boolean) || []);
    const comingIn = [...proposed].filter(p => !current.has(p));
    const goingOut = [...current].filter(p => !proposed.has(p));
    const changes = comingIn.length;

    const shown = (id, adjusted) => {
      const p = pinfo(id);
      if (p.raw == null || Math.abs(p.raw - adjusted) < 0.05) return adjusted.toFixed(1);
      // Never quietly show a different number than the app: give both.
      return `${p.raw.toFixed(1)}<span class="adj">${adjusted.toFixed(1)} exp.</span>`;
    };

    const rows = (r.lineup?.slots || []).map(s => {
      const swapIn = s.player_id && !current.has(s.player_id);
      return `<tr class="${s.locked ? 'lockedrow' : ''}${swapIn ? ' swapin' : ''}">
        <td><span class="slot">${esc(s.slot)}</span></td>
        <td class="who">${who(s.player_id)}
          ${swapIn ? `<span class="movetag in">start ${pronouns(pinfo(s.player_id).position).obj}</span>` : ''}
          ${s.locked ? '<span class="lockicon" title="game has kicked off">locked</span>' : ''}</td>
        <td class="n">${s.player_id ? shown(s.player_id, s.points) : s.points.toFixed(1)}</td></tr>`;
    }).join('');

    const bench = (r.lineup?.bench || []).slice(0, 10).map(([id, p]) => {
      const swapOut = current.has(id);
      return `<tr class="bench${swapOut ? ' swapout' : ''}">
        <td><span class="slot bn">BN</span></td>
        <td class="who">${who(id)}
          ${swapOut ? `<span class="movetag out">bench ${pronouns(pinfo(id).position).obj}</span>` : ''}</td>
        <td class="n dim">${shown(id, p)}</td></tr>`;
    }).join('');

    const note = r.lineup_locked
      ? 'week is locked, nothing can move'
      : changes
        ? `${changes} change${changes > 1 ? 's' : ''} from what you have set`
        : 'matches what you have set in Sleeper';

    const banner = changes ? `<div class="lineup-note">
      This is the lineup to move to, not the one you have set. Sleeper still has
      ${goingOut.map(p => `<b>${esc(pinfo(p).name)}</b>`).join(' and ')} starting.</div>` : '';

    return `<div class="card"><header><h3>Recommended lineup</h3>
      <span class="note">${esc(note)} · ${r.lineup ? r.lineup.total.toFixed(1) : '—'} projected</span></header>
      <div class="in">${banner}<table>
        <tr><th style="width:64px">Slot</th><th>Player</th><th class="n">Proj</th></tr>
        ${rows}${bench}</table></div></div>`;
  },

  waivers(r) {
    const rows = r.waivers.length ? r.waivers.map(w => `
      <tr><td class="cost ${r.uses_faab && !w.instant ? '' : 'pri'}">${
          w.instant ? 'FA' : r.uses_faab ? (w.faab_bid ? '$' + w.faab_bid : '—') : '#' + (r.waiver_position || '—')}</td>
        <td class="who"><b>${esc(w.name)}</b><span>${esc(w.position)}${w.team ? ' · ' + esc(w.team) : ''}</span>
          ${w.drop_id ? `<span class="sub2">drop ${esc(w.drop_name)}</span>` : ''}
          ${w.alternatives.length ? `<span class="sub2">or ${w.alternatives.map(a => esc(a.name)).join(', ')}</span>` : ''}</td>
        <td class="n up">+${w.marginal_ros.toFixed(1)}</td></tr>`).join('')
      : '<tr><td colspan="3" style="color:var(--ink-3);padding:14px 8px">No free agent improves your lineup.</td></tr>';
    return `<div class="card"><header><h3>Waiver targets</h3>
      <span class="note">${esc(r.next_waiver)}</span></header>
      <div class="in"><table>
        <tr><th style="width:52px">${r.uses_faab ? 'Bid' : 'Pri'}</th><th>Player</th><th class="n">ROS</th></tr>
        ${rows}</table></div></div>`;
  },

  drops(r) {
    const fix = r.roster_fix;
    const name = (id) => esc(pinfo(id).name);
    let banner = '';
    if (fix?.needed && (fix.over_by > 0 || fix.activate.length)) {
      const steps = [
        ...fix.activate.map(id => `Activate ${name(id)} from IR`),
        ...fix.toIR.map(id => `Move ${name(id)} to IR`),
        ...fix.drops.map(d => `Drop ${name(d.player_id)}`),
      ];
      banner = `<div class="overlimit">
        <b>${fix.active_count} players on a ${fix.limit}-man roster.</b>
        ${fix.over_by > 0 ? `You need to clear ${fix.over_by}.` : ''}
        <ol>${steps.map(x => `<li>${x}</li>`).join('')}</ol>
        ${fix.toIR.length && !fix.drops.length
          ? `<p>No one has to be cut. IR spots don't count against the limit.</p>` : ''}
      </div>`;
    } else if (fix?.toIR.length) {
      banner = `<div class="overlimit calm">You're under the limit. ${fix.toIR.map(name).join(' and ')}
        can still go on IR for a free bench spot.</div>`;
    }
    const cut = new Set((fix?.drops || []).map(d => d.player_id));
    const rows = r.drops.slice(0, 8).map(d => `
      <tr class="${cut.has(d.player_id) ? 'cutrow' : ''}"><td class="who">${who(d.player_id)}
          ${cut.has(d.player_id) ? '<span class="movetag out">drop</span>' : ''}
          ${(fix?.toIR || []).includes(d.player_id) ? '<span class="movetag ir">to IR</span>' : ''}</td>
        <td class="n ${d.cost > 0 ? '' : 'dim'}">${d.cost.toFixed(1)}</td></tr>`).join('');
    return `<div class="card"><header><h3>Who to drop</h3>
      <span class="note">points lost rest of season</span></header>
      <div class="in">${banner}<table>${rows}</table>
        <p class="foot">Each player is taken off your roster and your best lineup is
          re-set without him. The number is what that costs. This week's starters
          are left off the list.</p></div></div>`;
  },

  trades(r) {
    const body = r.trades.length ? r.trades.map((t, i) => {
      const cls = t.acceptance === 'likely' ? 'likely' : t.acceptance === 'possible' ? 'possible' : 'longshot';
      return `<div class="deal">
        <div class="hdr"><b>${esc(t.partner_name)}</b>
          <span class="tagx ${cls}">${esc(t.acceptance)}</span>
          <span class="dealgain">+${t.my_gain.toFixed(1)}</span></div>
        <div class="swap">
          <div class="lb">send</div><div class="out">${t.send.map(plain).join(', ')}</div>
          <div class="lb">get</div><div class="inn">${t.receive.map(plain).join(', ')}</div>
        </div><p class="why">${esc(t.rationale)}</p>
        ${t.proposal ? `<details class="pkg" data-deal="${i}">
          <summary>Trade proposal package</summary>
          <div class="pkg-in">
            <div class="pkg-card" id="pkgcard-${i}"></div>
            <div class="pkg-actions">
              <button class="btn" data-copyimg="${i}">Copy image</button>
              <button class="btn" data-png="${i}">Download image</button>
            </div>
            <div class="pkg-pts">
              <div class="pkg-pts-h">Key points</div>
              <ul>${t.proposal.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
              <button class="btn quiet" data-copypts="${i}">Copy these points</button>
            </div>
          </div></details>` : ''}
        </div>`;
    }).join('') : `<div class="notice">${esc(r.trade_note || 'No mutually beneficial trades right now.')}</div>`;
    return `<div class="card"><header><h3>Trades to send</h3>
      <span class="note">both lineups improve</span></header>
      <div class="in">${body}</div></div>`;
  },

  offers(r) {
    const st = r._state;
    if (!st?.me) return '';
    const pn = (id) => {
      const p = st.players.get(id);
      return p ? { name: p.name, pos: p.position, team: p.team || '' } : { name: id, pos: '', team: '' };
    };
    const ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
    const sorted = (ids) => [...ids].sort((a, b) =>
      (ORDER.indexOf(pn(a).pos) - ORDER.indexOf(pn(b).pos))
      || ((r._ros[b] || 0) - (r._ros[a] || 0)));
    const opps = st.opponents();
    const partner = OFFER.partner ?? opps[0]?.roster_id;
    const them = st.teams[partner];
    const box = (side, id) => {
      const p = pn(id);
      const on = OFFER[side].includes(id);
      return `<label class="pick ${on ? 'on' : ''}"><input type="checkbox" data-side="${side}" value="${esc(id)}" ${on ? 'checked' : ''}>
        <b>${esc(p.name)}</b><span>${esc(p.pos)}${p.team ? ' · ' + esc(p.team) : ''}</span>
        <em>${(r._ros[id] || 0).toFixed(0)}</em></label>`;
    };
    const res = OFFER.result;
    const sign = (x) => (x >= 0 ? '+' : '') + x.toFixed(1);
    const out = !res ? '' : `<div class="verdict ${res.tone}">
        <div class="vh">${esc(res.verdict)}</div>
        <p>${res.verdict === 'Accept'
          ? `Your starting lineup gets ${res.my_gain.toFixed(1)} points better over the rest of the season, which clears the ${res.min_gain}-point bar for a trade.`
          : res.verdict === 'Too close to call'
          ? (res.my_gain < 0.05
              ? `It doesn't change your best lineup over the rest of the season${Math.abs(res.my_week) >= 0.05 ? `, only this week (${sign(res.my_week)})` : ''}. Take it if you like the player, but the numbers don't care.`
              : `It helps you by ${res.my_gain.toFixed(1)}, under the ${res.min_gain}-point bar. That's inside the projection noise, so on numbers alone it's a coin flip.`)
          : `Your starting lineup gets ${Math.abs(res.my_gain).toFixed(1)} points worse over the rest of the season.`}</p>
      </div>
      <div class="ostats">
        <div><div class="k">${esc(st.me.label)} ROS</div><div class="v ${res.my_gain >= 0 ? 'up' : 'down'}">${sign(res.my_gain)}</div><div class="s">${sign(res.my_per_week)} / week</div></div>
        <div><div class="k">${esc(st.me.label)} week ${r.week}</div><div class="v ${res.my_week >= 0 ? 'up' : 'down'}">${sign(res.my_week)}</div><div class="s">this week only</div></div>
        <div><div class="k">${esc(res.partner_name)} ROS</div><div class="v ${res.their_gain >= 0 ? 'up' : 'down'}">${sign(res.their_gain)}</div><div class="s">their lineup</div></div>
        <div><div class="k">Value ratio</div><div class="v">${res.value_ratio != null ? res.value_ratio.toFixed(2) + 'x' : '—'}</div><div class="s">you send / you get</div></div>
      </div>
      ${res.forced_drops.length || res.forced_ir.length ? `<div class="notice">Taking this leaves your roster over the limit, so it also means
        ${[...res.forced_ir.map(id => `moving ${esc(pn(id).name)} to IR`),
           ...res.forced_drops.map(d => `dropping ${esc(d.name.split(' (')[0])} (${d.cost.toFixed(1)} pts)`)].join(' and ')}.
        That's already counted in the numbers above.</div>` : ''}
      ${res.their_forced.length ? `<p class="foot">${esc(res.partner_name)} would have to cut
        ${res.their_forced.map(d => esc(d.name.split(' (')[0])).join(' and ')} to make room.</p>` : ''}
      ${res.counter ? `<div class="counter"><div class="pkg-pts-h">Counter that clears the bar</div>
        <p><b>${esc(res.counter.note[0].toUpperCase() + res.counter.note.slice(1))}.</b>
        You send ${res.counter.give.map(id => esc(pn(id).name)).join(', ') || 'nothing'}, you get
        ${res.counter.get.map(id => esc(pn(id).name)).join(', ')}. Your lineup ${sign(res.counter.my_gain)},
        theirs ${sign(res.counter.their_gain)}.</p></div>`
        : res.verdict !== 'Accept' ? '<p class="foot">No single extra player or removal turns this into a deal worth taking.</p>' : ''}
      ${res.proposal ? `<details class="pkg" data-offercard>
        <summary>Analysis card</summary>
        <div class="pkg-in"><div class="pkg-card" id="pkgcard-offer"></div>
          <div class="pkg-pts"><div class="pkg-pts-h">Key points</div>
            <ul>${res.proposal.points.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div></div></details>` : ''}`;

    return `<div class="card"><header><h3>Offers received</h3>
      <span class="note">enter it as it appears in Sleeper</span></header>
      <div class="in">
        <p class="spec-lede">Sleeper keeps pending offers private to your login, so
          this site can't see them. Pick the team and tick what's in the offer.</p>
        <div class="ofrom"><span>From</span>
          <select id="offer-team">${opps.map(t =>
            `<option value="${t.roster_id}" ${t.roster_id === partner ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>
        <div class="ocols">
          <div><div class="olbl">They send you <i>pts left this season</i></div>
            ${them ? sorted(them.activePlayers()).map(id => box('get', id)).join('') : ''}</div>
          <div><div class="olbl">You send them <i>pts left this season</i></div>
            ${sorted(st.me.activePlayers()).map(id => box('give', id)).join('')}</div>
        </div>
        <div class="ogo"><button class="btn solid" id="offer-go" ${OFFER.get.length || OFFER.give.length ? '' : 'disabled'}>Analyze offer</button>
          ${res ? '<button class="btn quiet" id="offer-clear">Clear</button>' : ''}</div>
        <div id="offer-out">${out}</div>
      </div></div>`;
  },

  activity(r) {
    const body = r.changes.length ? r.changes.slice(0, 30).map(c => `
      <div class="ev"><span class="dot ${esc(c.severity)}"></span>
        <div>${esc(c.headline)}${c.affects_me ? '<span class="you">YOURS</span>' : ''}</div></div>`).join('')
      : '<div class="ev" style="color:var(--ink-3)">Nothing has changed since your last visit.</div>';
    return `<div class="card"><header><h3>What changed</h3></header>
      <div class="in">${body}</div></div>`;
  },

  closeCalls(r) {
    const list = r.close_calls || [];
    if (!list.length) return '';
    return `<div class="card"><header><h3>Too close to call</h3>
      <span class="note">the projection cannot separate these</span></header>
      <div class="in">
        <p class="spec-lede">The gap here is smaller than the error on the
          projection, so the number is not really evidence. Where something
          outside the projection points one way, it is below. Where nothing
          does, leaving it alone is the sane answer.</p>
        ${list.map(c => `<div class="tie">
          <div class="tie-row">
            <div class="tie-side"><b>${esc(c.in_name)}</b><span>${c.in_points.toFixed(1)}</span></div>
            <div class="tie-vs">vs</div>
            <div class="tie-side"><b>${esc(c.out_name)}</b><span>${c.out_points.toFixed(1)}</span></div>
            <div class="tie-slot">${esc(c.slot || '')}</div>
          </div>
          <div class="tie-verdict ${c.verdict === 'lean to the swap' ? 'lean' : 'stay'}">
            ${c.verdict === 'lean to the swap'
              ? `Lean to ${esc(c.in_name)}` : 'Leave it as it is'}
            <em>gap of ${c.gap.toFixed(1)}, inside the margin of error</em>
          </div>
          ${(c.tiebreak?.reasons || []).length
            ? `<ul class="tie-why">${c.tiebreak.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`
            : `<p class="tie-why-none">Nothing outside the projection separates
                 them, so this is preference. Churn costs you nothing here, but
                 it gains you nothing either.</p>`}
        </div>`).join('')}
      </div></div>`;
  },

  speculative(r) {
    const list = r.speculative || [];
    if (!list.length) return '';
    return `<div class="card spec"><header><h3>High risk, high reward</h3>
      <span class="note">worth real points, but unlikely to come off</span></header>
      <div class="in">
        <p class="spec-lede">These are kept out of the list above so that list
          stays unanimous. Each one is worth chasing if you want the upside —
          just don't count on it.</p>
        ${list.map(a => `<div class="act spec-act">
          <div class="line"><span class="rk">↑</span>
            <div class="actbody"><h4>${esc(a.headline)}</h4>
              ${a.detail ? `<p>${esc(a.detail)}</p>` : ''}</div></div>
          <div class="meta-row">
            <span class="pillx pts">+${a.impact.toFixed(1)} pts rest of season</span>
            <span class="pillx spec-why">${esc(
              a.kind === 'trade' ? 'they will probably say no'
                                 : 'does nothing for you this week')}</span>
          </div></div>`).join('')}
      </div></div>`;
  },

  reminders(r) {
    const link = r.league_id && r.league_id !== 'EXAMPLE'
      ? `<a class="sleeperlink" href="https://sleeper.com/leagues/${esc(r.league_id)}" target="_blank" rel="noopener">Open this league on Sleeper →</a>`
      : '';
    return `<div class="card"><header><h3>Reminders</h3>
      <span class="note">so you don't miss the window</span></header>
      <div class="in">
        <p class="remind-lede">This site has no server, so it can't message you
          on its own. It can hand your calendar the schedule instead — an alarm
          before every deadline, timed to this league's settings.</p>
        <div class="remind-group">
          <div class="remind-lbl">Remind me about</div>
          ${EVENT_KINDS.map(k => `<label class="chk">
            <input type="checkbox" data-kind="${k.id}" ${PREFS.remind.includes(k.id) ? 'checked' : ''}>
            <span>${esc(k.label)} <em>${esc(k.hint)}</em></span></label>`).join('')}
        </div>
        <div class="remind-group">
          <div class="remind-lbl">How far ahead</div>
          <div class="seg lead" id="leadseg">
            ${LEAD_TIMES.map(l => `<button data-lead="${l.id}" class="${PREFS.lead === l.id ? 'on' : ''}">${esc(l.label)}</button>`).join('')}
          </div>
        </div>
        <button class="btn solid" id="dlics">Add to my calendar</button>
        <p class="remind-foot">Downloads an .ics your phone or laptop can import.
          Want real push notifications instead? The Python version can poll on a
          schedule — see the repo.</p>
        ${link}
      </div></div>`;
  },

  rules(r) {
    return `<div class="card"><header><h3>House rules</h3></header>
      <div class="in"><ul class="rules">
        ${r.settings_summary.map(s => `<li>${esc(s)}</li>`).join('')}
        ${r.deadlines.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div></div>`;
  },
};

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'lineup',   label: 'Lineup' },
  { id: 'waivers',  label: 'Waivers' },
  { id: 'trades',   label: 'Trades' },
  { id: 'activity', label: 'Activity' },
  { id: 'league',   label: 'League' },
];

function tabBody(r, tab) {
  switch (tab) {
    case 'lineup':   return CARDS.lineup(r) + CARDS.closeCalls(r) + CARDS.drops(r);
    case 'waivers':  return CARDS.waivers(r) + CARDS.drops(r);
    case 'trades': {
      const v = PREFS.tradeView === 'received' ? 'received' : 'sent';
      const seg = `<div class="subseg"><div class="seg" id="tradeseg">
        <button data-tv="sent" class="${v === 'sent' ? 'on' : ''}">Sent</button>
        <button data-tv="received" class="${v === 'received' ? 'on' : ''}">Received</button></div></div>`;
      return seg + (v === 'sent' ? CARDS.trades(r) + CARDS.speculative(r) : CARDS.offers(r));
    }
    case 'activity': return CARDS.activity(r);
    case 'league':   return CARDS.rules(r) + CARDS.reminders(r);
    default:         return CARDS.hero(r) + CARDS.actions(r);
  }
}

function render(r, { isExample }) {
  REPORT = r;
  const mode = PREFS.mode === 'all' ? 'all' : 'tabs';
  const tab = TABS.some(t => t.id === PREFS.tab) ? PREFS.tab : 'overview';

  app().innerHTML = '';
  app().appendChild(node(`<div class="topbar">
    <div class="topbar-in">
      <div class="brand">${esc(r.league_name.trim())}</div>
      ${isExample ? '<span class="exbadge">example</span>' : ''}
      <div class="crumb">Week ${r.week} · <b>${esc(r.my_team)}</b> · ${esc(r.record)}</div>
      <div class="grow"></div>
      <div class="viewsel">
        <span class="viewlbl">Page view</span>
        <div class="seg" id="seg">
          <button data-mode="tabs" class="${mode === 'tabs' ? 'on' : ''}">Sections</button>
          <button data-mode="all" class="${mode === 'all' ? 'on' : ''}">One page</button>
        </div>
      </div>
      <div class="acts">
        <button class="btn" id="refresh">Refresh</button>
        <button class="btn quiet" id="switch">Switch</button>
      </div>
    </div>
    ${mode === 'tabs' ? `<div class="tabs" id="tabs">${TABS.map(t =>
      `<button data-tab="${t.id}" class="${t.id === tab ? 'on' : ''}">${t.label}</button>`).join('')}</div>` : ''}
  </div>`));

  const body = mode === 'all'
    ? `<main>${CARDS.hero(r)}
        <div class="cols">
          <div>${CARDS.actions(r)}${CARDS.closeCalls(r)}${CARDS.lineup(r)}${CARDS.trades(r)}${CARDS.offers(r)}${CARDS.speculative(r)}</div>
          <div>${CARDS.waivers(r)}${CARDS.drops(r)}${CARDS.activity(r)}${CARDS.rules(r)}${CARDS.reminders(r)}</div>
        </div></main>`
    : `<main class="focused">${tabBody(r, tab)}</main>`;
  app().appendChild(node(body));

  app().appendChild(node(`<div class="byline">
    Built by Brandon Zwicker · projections re-scored under each league's own
    settings · <a href="https://github.com/BrandonZwicker/fantasy-gm">source on GitHub</a>
  </div>`));

  document.getElementById('refresh').onclick = () => run(true);
  document.getElementById('switch').onclick = () => {
    drop(KEY); SESSION = null; REPORT = null; STATE = null; renderGate();
  };
  document.getElementById('seg').onclick = (e) => {
    const m = e.target.dataset.mode;
    if (!m || m === PREFS.mode) return;
    PREFS.mode = m; savePrefs(); render(r, { isExample });
  };
  // Trade proposal packages: render the card lazily when one is opened.
  document.querySelectorAll('details.pkg').forEach(d => {
    d.addEventListener('toggle', () => {
      if (!d.open) return;
      const i = d.dataset.deal;
      const host = document.getElementById(`pkgcard-${i}`);
      const deal = r.trades[i];
      if (host && deal?.proposal && !host.dataset.done) {
        host.innerHTML = buildSVG(deal.proposal);
        host.dataset.done = '1';
      }
    });
  });
  document.querySelectorAll('[data-copypts]').forEach(b => {
    b.onclick = async () => {
      const pts = r.trades[b.dataset.copypts]?.proposal?.points || [];
      const text = pts.map(p => `- ${p}`).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        hint('Key points copied');
      } catch { hint('Clipboard is blocked here, select the list instead'); }
    };
  });
  document.querySelectorAll('[data-copyimg]').forEach(b => {
    b.onclick = async () => {
      const deal = r.trades[b.dataset.copyimg];
      if (!deal?.proposal) return;
      try {
        const blob = await svgToPng(buildSVG(deal.proposal));
        // Writing an image needs ClipboardItem, which not every browser exposes.
        if (navigator.clipboard?.write && window.ClipboardItem) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          hint('Image copied, paste it straight into a message');
        } else {
          throw new Error('no image clipboard');
        }
      } catch {
        hint('This browser will not copy images, use Download instead');
      }
    };
  });
  document.querySelectorAll('[data-png]').forEach(b => {
    b.onclick = async () => {
      const deal = r.trades[b.dataset.png];
      if (!deal?.proposal) return;
      try {
        const blob = await svgToPng(buildSVG(deal.proposal));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `trade-${deal.partner_name.replace(/\W+/g, '-').toLowerCase()}.png`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        hint('Graphic downloaded');
      } catch { hint('Could not render the graphic here'); }
    };
  });

  // Reminder controls (present on the League tab and in one-page mode).
  const leadSeg = document.getElementById('leadseg');
  if (leadSeg) leadSeg.onclick = (e) => {
    const v = e.target.dataset.lead;
    if (!v) return;
    PREFS.lead = v; savePrefs();
    [...leadSeg.children].forEach(c => c.classList.toggle('on', c.dataset.lead === v));
  };
  document.querySelectorAll('[data-kind]').forEach(box => {
    box.onchange = () => {
      PREFS.remind = [...document.querySelectorAll('[data-kind]')]
        .filter(b => b.checked).map(b => b.dataset.kind);
      savePrefs();
    };
  });
  const dl = document.getElementById('dlics');
  if (dl) dl.onclick = () => {
    const mins = (LEAD_TIMES.find(l => l.id === PREFS.lead) || LEAD_TIMES[1]).minutes;
    downloadICS(r, { kinds: PREFS.remind, leadMinutes: mins });
    hint('Calendar file downloaded — open it to add the reminders');
  };

  wireOffers(r, isExample);

  const tabsEl = document.getElementById('tabs');
  if (tabsEl) tabsEl.onclick = (e) => {
    const t = e.target.dataset.tab;
    if (!t || t === PREFS.tab) return;
    PREFS.tab = t; savePrefs(); render(r, { isExample });
    window.scrollTo(0, 0);
  };
}

/* ================= offer analyser ================= */

function wireOffers(r, isExample) {
  const keepScroll = () => { const y = window.scrollY; render(r, { isExample }); window.scrollTo(0, y); };
  const seg = document.getElementById('tradeseg');
  if (seg) seg.onclick = (e) => {
    const v = e.target.dataset.tv;
    if (!v || v === PREFS.tradeView) return;
    PREFS.tradeView = v; savePrefs(); keepScroll();
  };
  const team = document.getElementById('offer-team');
  if (!team) return;
  team.onchange = () => {
    OFFER = { partner: Number(team.value), give: OFFER.give, get: [], result: null };
    keepScroll();
  };
  document.querySelectorAll('input[data-side]').forEach(box => {
    box.onchange = () => {
      const side = box.dataset.side;
      OFFER[side] = box.checked ? [...OFFER[side], box.value]
                                : OFFER[side].filter(x => x !== box.value);
      OFFER.result = null;
      box.closest('.pick')?.classList.toggle('on', box.checked);
      const go = document.getElementById('offer-go');
      if (go) go.disabled = !(OFFER.give.length || OFFER.get.length);
      const out = document.getElementById('offer-out');
      if (out) out.innerHTML = '';
    };
  });
  const clear = document.getElementById('offer-clear');
  if (clear) clear.onclick = () => { OFFER = { partner: OFFER.partner, give: [], get: [], result: null }; keepScroll(); };
  const go = document.getElementById('offer-go');
  if (go) go.onclick = () => {
    const st = r._state;
    const partner = OFFER.partner ?? Number(team.value);
    OFFER.partner = partner;
    const res = analyzeOffer(st, r._ros, r._weekPts, r._levels, {
      partner, give: OFFER.give, get: OFFER.get,
      minGain: r.thresholds?.tradeGain ?? 8, isLocked: r._isLocked,
    });
    if (res) {
      try {
        const c = buildCase(st, { partner_roster_id: partner, send: OFFER.give,
          receive: OFFER.get, value_ratio: res.value_ratio, acceptance: null }, r._ros);
        if (c) res.proposal = { ...c, points: buildKeyPoints(c) };
      } catch { /* the card is extra; the verdict stands without it */ }
    }
    OFFER.result = res;
    keepScroll();
    document.getElementById('offer-out')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const card = document.querySelector('details[data-offercard]');
  if (card) card.addEventListener('toggle', () => {
    const host = document.getElementById('pkgcard-offer');
    if (card.open && host && !host.dataset.done && OFFER.result?.proposal) {
      host.innerHTML = buildSVG(OFFER.result.proposal);
      host.dataset.done = '1';
    }
  });
}

/* ================= boot ================= */

function loading(name) {
  app().innerHTML = `<div class="loading">
    <div class="mark">Reading ${esc((name || 'your league').trim())}</div>
    <div class="prog" id="prog"></div>
    <div class="bar"><i></i></div></div>`;
}
const setProg = (m) => { const e = document.getElementById('prog'); if (e) e.textContent = m; };

async function startExample() {
  SESSION = { kind: 'example' };
  writeJSON(KEY, SESSION);
  run();
}

async function run(force) {
  if (!SESSION) return renderGate();
  const isExample = SESSION.kind === 'example';

  loading(isExample ? 'the example league' : SESSION.league_name);
  try {
    let opts = { onProgress: setProg }, leagueId, userId;
    if (isExample) {
      const ex = await EXAMPLE.load();
      opts.source = ex.source;
      leagueId = ex.league_id; userId = ex.user_id;
    } else {
      leagueId = SESSION.league_id; userId = SESSION.user_id;
    }

    const r = await buildReport(leagueId, userId, opts);
    STATE = r._state;
    render(r, { isExample });

    // Sleeper publishes only a couple of weeks of projections ahead. Pull the
    // rest in the background so byes and rest-of-season sharpen, then
    // quietly re-render.
    refine(r._state).then(async () => {
      const better = await assemble(r._state);
      render(better, { isExample });
      hint('Updated with the full remaining schedule');
    }).catch(() => {});
  } catch (e) {
    drop(KEY); SESSION = null;
    renderGate(e.message);
  }
}

// Always land on the sign-in page. A remembered league is offered there as a
// one-click "Continue" rather than loaded automatically, so opening the link
// never drops a visitor straight into somebody else's team.
renderGate();
