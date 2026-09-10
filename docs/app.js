/* Fantasy GM — UI. Everything runs client-side; there is no server. */

import { Sleeper } from './engine.js';
import { DEFAULT_RISK, RISK_PROFILES, assemble, buildReport, refine } from './report.js';
import { EXAMPLE, PLATFORMS } from './providers.js';
import { EVENT_KINDS, LEAD_TIMES, downloadICS } from './reminders.js';

const KEY = 'fantasy-gm.session';
const PREF = 'fantasy-gm.prefs';
const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k)) || null; } catch { return null; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const drop = (k) => { try { localStorage.removeItem(k); } catch {} };

let SESSION = readJSON(KEY);
let PREFS = { mode: 'tabs', tab: 'overview', risk: DEFAULT_RISK,
              remind: ['waivers', 'kickoff'], lead: '3h',
              ...(readJSON(PREF) || {}) };
let REPORT = null;
let STATE = null;

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
    <div class="mark">Fantasy <em>GM</em></div>
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

function actionHTML(a) {
  const alts = a.payload?.alternatives || [];
  const why = a.reasoning || [];
  const whyHTML = why.length ? `
    <details><summary>Why this move?</summary>
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
  const dl = a.deadline;
  const check = dl && !dl.locked
    ? `<span class="pillx check">final check ${new Date(dl.check_by)
        .toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>`
    : dl && dl.locked ? '<span class="pillx locked">window closed</span>' : '';
  return `<div class="act">
    <div class="line">
      <span class="rk ${a.rank <= 2 ? 'top' : ''}">${a.rank}</span>
      <span class="chip t${a.priority}">${esc(a.tier_label || '')}</span>
      <div class="actbody"><h4>${esc(a.headline)}</h4>
        ${a.detail ? `<p>${esc(a.detail)}</p>` : ''}</div>
    </div>
    <div class="meta-row">${pts}${rate}${conf}${check}
      ${a.horizon ? `<span class="pillx when">${esc(a.horizon)}</span>` : ''}</div>
    ${(whyHTML || altHTML) ? `<div class="disc">${whyHTML}${altHTML}</div>` : ''}
  </div>`;
}

const CARDS = {
  hero(r) {
    const floor = r.risk_profile?.startSit ?? 0.1;
    const up = r.lineup_gain >= floor;
    // A gain that exists but sits under the threshold is noise, not an
    // opportunity — say so rather than dangling a number we won't act on.
    const marginal = !up && r.lineup_gain > 0.1;
    return `<div class="hero">
      <div class="fig ${up ? '' : 'flat'}">${up ? '+' + r.lineup_gain.toFixed(1) : '✓'}</div>
      <div class="say">
        <h2>${up ? 'Points left on your bench'
                 : marginal ? 'Lineup is good enough'
                 : 'Your lineup is set correctly'}</h2>
        <p>${up ? `Fixing your week ${r.week} lineup is worth ${r.lineup_gain.toFixed(1)} more projected points.`
             : marginal ? `The best change available is worth ${r.lineup_gain.toFixed(1)} points — inside the projection noise, so it isn't worth the move.`
             : `Nothing to change for week ${r.week} — the optimal starters are already in.`}</p>
      </div>
      <div class="meta">
        <div><div class="k">Record</div><div class="v">${esc(r.record)}</div></div>
        <div><div class="k">Projected</div><div class="v">${r.lineup ? r.lineup.total.toFixed(1) : '—'}</div></div>
        <div><div class="k">${r.uses_faab ? 'FAAB left' : 'Priority'}</div>
          <div class="v">${r.uses_faab ? '$' + r.faab_left : '#' + (r.waiver_position || '—')}</div></div>
      </div></div>`;
  },

  actions(r) {
    const held = r.held_back
      ? `<details class="heldback"><summary>${r.held_back} smaller move${r.held_back > 1 ? 's' : ''} not worth making at ${(r.risk_profile?.label || '').toLowerCase()} risk</summary>
           <div class="rz">${(r.held_back_detail || []).map(h => `<div class="st">
             <h5>${esc(h.headline)}</h5><p>worth ${(+h.impact).toFixed(1)} pts</p></div>`).join('')}
           <div class="st"><p>Projections carry a few points of error, so edges
             this small are as likely to cost you as gain you. Raise the risk
             setting above to act on them anyway.</p></div></div></details>`
      : '';
    const body = r.actions.length ? r.actions.map(actionHTML).join('') + held
      : `<div class="allclear"><span class="big">All clear</span>
         No moves worth making right now. Check back after the next games.</div>${held}`;
    return `<div class="card"><header><h3>What to do</h3>
      <span class="note">${r.actions.length} item${r.actions.length === 1 ? '' : 's'} · ranked by points at stake and how soon you lose the chance</span></header>
      <div class="in">${body}</div></div>`;
  },

  lineup(r) {
    const shown = (id, adjusted) => {
      const p = pinfo(id);
      if (p.raw == null || Math.abs(p.raw - adjusted) < 0.05) return adjusted.toFixed(1);
      // Never quietly show a different number than the app: give both.
      return `${p.raw.toFixed(1)}<span class="adj">${adjusted.toFixed(1)} exp.</span>`;
    };
    const rows = (r.lineup?.slots || []).map(s => `
      <tr><td><span class="slot">${esc(s.slot)}</span></td>
        <td class="who">${who(s.player_id)}</td>
        <td class="n">${s.player_id ? shown(s.player_id, s.points) : s.points.toFixed(1)}</td></tr>`).join('');
    const bench = (r.lineup?.bench || []).slice(0, 10).map(([id, p]) => `
      <tr class="bench"><td><span class="slot bn">BN</span></td>
        <td class="who">${who(id)}</td><td class="n dim">${shown(id, p)}</td></tr>`).join('');
    return `<div class="card"><header><h3>Week ${r.week} lineup</h3>
      <span class="note">${r.lineup ? r.lineup.total.toFixed(1) : '—'} projected</span></header>
      <div class="in"><table>
        <tr><th style="width:64px">Slot</th><th>Player</th><th class="n">Proj</th></tr>
        ${rows}${bench}</table></div></div>`;
  },

  waivers(r) {
    const rows = r.waivers.length ? r.waivers.map(w => `
      <tr><td class="cost ${r.uses_faab ? '' : 'pri'}">${
          r.uses_faab ? (w.faab_bid ? '$' + w.faab_bid : '—') : '#' + (r.waiver_position || '—')}</td>
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
    const rows = r.drops.slice(0, 6).map(d => `
      <tr><td class="who">${who(d.player_id)}</td>
        <td class="n ${d.cost > 0 ? '' : 'dim'}">${d.cost.toFixed(1)}</td></tr>`).join('');
    return `<div class="card"><header><h3>Safest drops</h3>
      <span class="note">points it costs you</span></header>
      <div class="in"><table>${rows}</table></div></div>`;
  },

  trades(r) {
    const body = r.trades.length ? r.trades.map(t => {
      const cls = t.acceptance === 'likely' ? 'likely' : t.acceptance === 'possible' ? 'possible' : 'longshot';
      return `<div class="deal">
        <div class="hdr"><b>${esc(t.partner_name)}</b>
          <span class="tagx ${cls}">${esc(t.acceptance)}</span>
          <span class="dealgain">+${t.my_gain.toFixed(1)}</span></div>
        <div class="swap">
          <div class="lb">send</div><div class="out">${t.send.map(plain).join(', ')}</div>
          <div class="lb">get</div><div class="inn">${t.receive.map(plain).join(', ')}</div>
        </div><p class="why">${esc(t.rationale)}</p></div>`;
    }).join('') : `<div class="notice">${esc(r.trade_note || 'No mutually beneficial trades right now.')}</div>`;
    return `<div class="card"><header><h3>Trades worth offering</h3></header>
      <div class="in">${body}</div></div>`;
  },

  activity(r) {
    const body = r.changes.length ? r.changes.slice(0, 30).map(c => `
      <div class="ev"><span class="dot ${esc(c.severity)}"></span>
        <div>${esc(c.headline)}${c.affects_me ? '<span class="you">YOURS</span>' : ''}</div></div>`).join('')
      : '<div class="ev" style="color:var(--ink-3)">Nothing has changed since your last visit.</div>';
    return `<div class="card"><header><h3>What changed</h3></header>
      <div class="in">${body}</div></div>`;
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
    case 'lineup':   return CARDS.lineup(r) + CARDS.drops(r);
    case 'waivers':  return CARDS.waivers(r) + CARDS.drops(r);
    case 'trades':   return CARDS.trades(r);
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
  app().appendChild(node(`<div class="top">
    <div class="top-in">
      <div class="brand">${esc(r.league_name.trim())}</div>
      ${isExample ? '<span class="exbadge">example</span>' : ''}
      <div class="crumb">Week ${r.week} · <b>${esc(r.my_team)}</b> · ${esc(r.record)}</div>
      <div class="grow"></div>
      <div class="viewsel">
        <span class="viewlbl">Risk</span>
        <div class="seg" id="riskseg">
          ${Object.entries(RISK_PROFILES).map(([k, v]) =>
            `<button data-risk="${k}" title="${esc(v.blurb)}" class="${PREFS.risk === k ? 'on' : ''}">${esc(v.label)}</button>`).join('')}
        </div>
      </div>
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
          <div>${CARDS.actions(r)}${CARDS.lineup(r)}${CARDS.trades(r)}</div>
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
  document.getElementById('riskseg').onclick = (e) => {
    const v = e.target.dataset.risk;
    if (!v || v === PREFS.risk) return;
    PREFS.risk = v; savePrefs();
    // Recompute from the loaded state; no refetch needed.
    if (STATE) assemble(STATE, { risk: v }).then(rep => render(rep, { isExample }));
  };
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

  const tabsEl = document.getElementById('tabs');
  if (tabsEl) tabsEl.onclick = (e) => {
    const t = e.target.dataset.tab;
    if (!t || t === PREFS.tab) return;
    PREFS.tab = t; savePrefs(); render(r, { isExample });
    window.scrollTo(0, 0);
  };
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
    let opts = { onProgress: setProg, risk: PREFS.risk }, leagueId, userId;
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
      const better = await assemble(r._state, { risk: PREFS.risk });
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
