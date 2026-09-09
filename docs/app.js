/* Fantasy GM — UI. Everything runs client-side; there is no server. */

import { Sleeper } from './engine.js';
import { assemble, buildReport, refine } from './report.js';

// The league shown to anyone who hasn't picked their own. Leaguemates are
// anonymised here — their Sleeper handles aren't ours to publish.
const DEFAULT = {
  league_id: '1393414438685519872',
  league_name: 'Biggest Tripping',
  user_id: '1005323016137879552',
  username: 'zwickyy',
  anonymize: true,
};

const KEY = 'fantasy-gm.session';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };
const clear = () => { try { localStorage.removeItem(KEY); } catch {} };

let SESSION = load();
let FORCE_SETUP = false;
let REPORT = null;

const node = (h) => { const d = document.createElement('div'); d.innerHTML = h.trim(); return d.firstChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const app = () => document.getElementById('app');

const pinfo = (id) => REPORT?.player_names?.[id] || { name: id, position: '', team: '', injury: '' };
function who(id) {
  if (!id) return '<span class="vacant">— empty —</span>';
  const p = pinfo(id);
  return `<b>${esc(p.name)}</b><span>${esc(p.position)}${p.team ? ' · ' + esc(p.team) : ''}</span>`
       + (p.injury ? `<span class="hurt">${esc(p.injury)}</span>` : '');
}
const plain = (id) => esc(pinfo(id).name);

function hint(msg) {
  const h = document.getElementById('hint');
  if (!h) return;
  if (!msg) { h.classList.remove('on'); return; }
  h.textContent = msg;
  h.classList.add('on');
  setTimeout(() => h.classList.remove('on'), 4000);
}

/* ---------------- setup ---------------- */

function renderGate(msg) {
  app().innerHTML = '';
  const g = node(`<div class="gate">
    <div class="mark">Fantasy <em>GM</em></div>
    <p class="lede">Reads your Sleeper league end to end and tells you exactly what
      to do about it. Read-only — nothing is ever posted to your account, and there
      is no server: everything runs in this browser.</p>
    ${msg ? `<div class="warn">${esc(msg)}</div>` : ''}
    <input class="field" id="u" placeholder="Sleeper username" autocomplete="off" spellcheck="false">
    <button class="btn solid" id="go">Find my leagues</button>
    <div class="rule">or use a league ID</div>
    <input class="field" id="lid" placeholder="League ID" autocomplete="off">
    <button class="btn" id="golid">Load that league</button>
    <div id="out" style="margin-top:18px"></div>
    <div class="rule">or</div>
    <div class="opt-row" id="demo"><div><b>${esc(DEFAULT.league_name)}</b>
      <div class="s">example league · see it working</div></div>
      <span class="arw">→</span></div>
  </div>`);
  app().appendChild(g);

  const inp = g.querySelector('#u'), out = g.querySelector('#out');
  const go = g.querySelector('#go'), lid = g.querySelector('#lid');
  inp.focus();

  const choose = (username, user_id, l) => {
    FORCE_SETUP = false;
    SESSION = { username, user_id, league_id: l.league_id, league_name: l.name,
                anonymize: false };
    save(SESSION);
    run();
  };

  g.querySelector('#demo').onclick = () => {
    FORCE_SETUP = false; SESSION = null; clear(); run();
  };

  const byUser = async () => {
    const u = inp.value.trim(); if (!u) return;
    go.disabled = true; out.innerHTML = '<p class="lede">Searching…</p>';
    try {
      const user = await Sleeper.user(u);
      if (!user) throw new Error(`No Sleeper user named “${u}”`);
      const season = (await Sleeper.state()).season;
      const leagues = await Sleeper.userLeagues(user.user_id, season) || [];
      if (!leagues.length) {
        out.innerHTML = `<div class="warn">No ${esc(season)} leagues for “${esc(u)}”.
          Try the league ID instead.</div>`;
      } else {
        out.innerHTML = '<div class="rule">choose a league</div>';
        for (const l of leagues) {
          const r = node(`<div class="opt-row"><div><b>${esc(l.name)}</b>
            <div class="s">${l.total_rosters} teams · ${esc(season)}</div></div>
            <span class="arw">→</span></div>`);
          r.onclick = () => choose(u, user.user_id, l);
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

/* ---------------- dashboard ---------------- */

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
  const pts = a.impact > 0.05 ? `<span class="pillx pts">${a.impact.toFixed(1)} pts at stake</span>` : '';
  const rate = (a.per_week > 0.05 && a.kind !== 'start_sit')
    ? `<span class="pillx">${a.per_week.toFixed(1)} / week</span>` : '';
  return `<div class="act">
    <div class="line">
      <span class="rk ${a.rank <= 2 ? 'top' : ''}">${a.rank}</span>
      <span class="chip t${a.priority}">${esc(a.tier_label || '')}</span>
      <div style="flex:1"><h4>${esc(a.headline)}</h4>
        ${a.detail ? `<p>${esc(a.detail)}</p>` : ''}</div>
    </div>
    <div class="meta-row">${pts}${rate}
      ${a.horizon ? `<span class="pillx when">${esc(a.horizon)}</span>` : ''}</div>
    ${(whyHTML || altHTML) ? `<div class="disc">${whyHTML}${altHTML}</div>` : ''}
  </div>`;
}

function render(r, { isDemo }) {
  REPORT = r;
  const up = r.lineup_gain > 0.1;
  const openIds = new Set([...document.querySelectorAll('.disc details[open]')]
    .map((d, i) => i));   // preserve disclosures across silent re-render

  const hero = `<div class="hero">
    <div class="fig ${up ? '' : 'flat'}">${up ? '+' + r.lineup_gain.toFixed(1) : '✓'}</div>
    <div class="say">
      <h2>${up ? 'Points left on your bench' : 'Your lineup is set correctly'}</h2>
      <p>${up ? `Fixing your week ${r.week} lineup is worth ${r.lineup_gain.toFixed(1)} more projected points.`
              : `Nothing to change for week ${r.week} — the optimal starters are already in.`}</p>
    </div>
    <div class="meta">
      <div><div class="k">Record</div><div class="v">${esc(r.record)}</div></div>
      <div><div class="k">Projected</div><div class="v">${r.lineup ? r.lineup.total.toFixed(1) : '—'}</div></div>
      <div><div class="k">${r.uses_faab ? 'FAAB left' : 'Priority'}</div>
        <div class="v">${r.uses_faab ? '$' + r.faab_left : '#' + (r.waiver_position || '—')}</div></div>
    </div>
  </div>`;

  const demoNote = isDemo ? `<div class="demo-note">
    <b>You're seeing a live example league.</b> Every number is computed in your
    browser right now from Sleeper's public API — nothing here is canned.
    Leaguemates are shown as “Team&nbsp;N” because their usernames aren't mine to
    publish. Use <b>Switch</b> above to run it on your own league.</div>` : '';

  const acts = r.actions.length ? r.actions.map(actionHTML).join('')
    : `<div class="allclear"><span class="big">All clear</span>
       No moves needed right now. Check back after the next games.</div>`;

  const lineup = (r.lineup?.slots || []).map(s => `
    <tr><td><span class="slot">${esc(s.slot)}</span></td>
      <td class="who">${who(s.player_id)}</td>
      <td class="n">${s.points.toFixed(1)}</td></tr>`).join('');
  const bench = (r.lineup?.bench || []).slice(0, 8).map(([id, p]) => `
    <tr class="bench"><td><span class="slot bn">BN</span></td>
      <td class="who">${who(id)}</td><td class="n dim">${p.toFixed(1)}</td></tr>`).join('');

  const waivers = r.waivers.length ? r.waivers.map(w => `
    <tr><td class="cost ${r.uses_faab ? '' : 'pri'}">${
        r.uses_faab ? (w.faab_bid ? '$' + w.faab_bid : '—') : '#' + (r.waiver_position || '—')}</td>
      <td class="who"><b>${esc(w.name)}</b><span>${esc(w.position)}${w.team ? ' · ' + esc(w.team) : ''}</span>
        ${w.drop_id ? `<span style="display:block;color:var(--ink-3);font-size:12px;margin:2px 0 0">drop ${esc(w.drop_name)}</span>` : ''}
        ${w.alternatives.length ? `<span style="display:block;color:var(--ink-3);font-size:11.5px;margin-top:2px">or ${
          w.alternatives.map(a => esc(a.name)).join(', ')}</span>` : ''}</td>
      <td class="n up">+${w.marginal_ros.toFixed(1)}</td></tr>`).join('')
    : '<tr><td colspan="3" style="color:var(--ink-3);padding:14px 8px">No free agent improves your lineup.</td></tr>';

  const deals = r.trades.length ? r.trades.map(t => {
    const cls = t.acceptance === 'likely' ? 'likely' : t.acceptance === 'possible' ? 'possible' : 'longshot';
    return `<div class="deal">
      <div class="hdr"><b>${esc(t.partner_name)}</b>
        <span class="tagx ${cls}">${esc(t.acceptance)}</span>
        <span style="margin-left:auto;font-size:13px;font-weight:600;color:var(--gain)">+${t.my_gain.toFixed(1)}</span></div>
      <div class="swap">
        <div class="lb">send</div><div class="out">${t.send.map(plain).join(', ')}</div>
        <div class="lb">get</div><div class="inn">${t.receive.map(plain).join(', ')}</div>
      </div><p class="why">${esc(t.rationale)}</p></div>`;
  }).join('') : `<div class="notice">${esc(r.trade_note || 'No mutually beneficial trades right now.')}</div>`;

  const feed = r.changes.length ? r.changes.slice(0, 20).map(c => `
    <div class="ev"><span class="dot ${esc(c.severity)}"></span>
      <div>${esc(c.headline)}${c.affects_me ? '<span class="you">YOURS</span>' : ''}</div></div>`).join('')
    : '<div class="ev" style="color:var(--ink-3)">Nothing has changed since your last visit.</div>';

  const drops = r.drops.slice(0, 5).map(d => `
    <tr><td class="who">${who(d.player_id)}</td>
      <td class="n ${d.cost > 0 ? '' : 'dim'}">${d.cost.toFixed(1)}</td></tr>`).join('');

  app().innerHTML = '';
  app().appendChild(node(`<div class="top"><div class="top-in">
    <div class="brand">${esc(r.league_name.trim())}</div>
    <div class="crumb">Week ${r.week} · <b>${esc(r.my_team)}</b> · ${esc(r.record)}</div>
    <div class="grow"></div>
    <div class="crumb">Waivers ${esc(r.next_waiver)}</div>
    <div class="tools">
      <button class="btn" id="refresh">Refresh</button>
      <button class="btn quiet" id="switch">Switch</button>
    </div></div></div>`));

  app().appendChild(node(`<main>
    ${hero}${demoNote}
    <div class="cols">
      <div>
        <div class="card"><header><h3>What to do</h3>
          <span class="note">${r.actions.length} item${r.actions.length === 1 ? '' : 's'} · ranked by points at stake and how soon you lose the chance</span></header>
          <div class="in">${acts}</div></div>
        <div class="card"><header><h3>Week ${r.week} lineup</h3>
          <span class="note">${r.lineup ? r.lineup.total.toFixed(1) : '—'} projected</span></header>
          <div class="in"><table>
            <tr><th style="width:64px">Slot</th><th>Player</th><th class="n">Proj</th></tr>
            ${lineup}${bench}</table></div></div>
        <div class="card"><header><h3>Trades worth offering</h3></header>
          <div class="in">${deals}</div></div>
      </div>
      <div>
        <div class="card"><header><h3>Waiver targets</h3></header>
          <div class="in"><table>
            <tr><th style="width:52px">${r.uses_faab ? 'Bid' : 'Pri'}</th><th>Player</th><th class="n">ROS</th></tr>
            ${waivers}</table></div></div>
        <div class="card"><header><h3>Safest drops</h3>
          <span class="note">points it costs you</span></header>
          <div class="in"><table>${drops}</table></div></div>
        <div class="card"><header><h3>What changed</h3></header>
          <div class="in">${feed}</div></div>
        <div class="card"><header><h3>House rules</h3></header>
          <div class="in"><ul class="rules">
            ${r.settings_summary.map(s => `<li>${esc(s)}</li>`).join('')}
            ${r.deadlines.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div></div>
      </div>
    </div>
  </main>`));

  app().appendChild(node(`<div class="byline">
    Built by Brandon Zwicker · projections re-scored under each league's own
    settings · runs entirely in your browser against Sleeper's public API ·
    <a href="https://github.com/BrandonZwicker/fantasy-gm">source on GitHub</a>
  </div>`));

  document.getElementById('refresh').onclick = () => run(true);
  document.getElementById('switch').onclick = () => {
    clear(); SESSION = null; REPORT = null; FORCE_SETUP = true; renderGate();
  };
}

/* ---------------- boot ---------------- */

function loading(name, msg) {
  app().innerHTML = `<div class="loading">
    <div class="mark">Reading ${esc((name || 'your league').trim())}</div>
    <p>No server involved — this is computing in your browser.</p>
    <div class="prog" id="prog">${esc(msg || '')}</div>
    <div class="bar"><i></i></div></div>`;
}
const setProg = (m) => { const e = document.getElementById('prog'); if (e) e.textContent = m; };

async function run(force) {
  if (!SESSION && !FORCE_SETUP) SESSION = { ...DEFAULT, name: DEFAULT.league_name };
  if (!SESSION) return renderGate();
  const isDemo = SESSION.league_id === DEFAULT.league_id && SESSION.anonymize !== false;

  loading(SESSION.league_name);
  try {
    const r = await buildReport(SESSION.league_id, SESSION.user_id,
                                { anonymize: Boolean(SESSION.anonymize), onProgress: setProg });
    render(r, { isDemo });

    // Sleeper only publishes a couple of weeks of projections ahead of time.
    // Pull the rest in the background so byes and rest-of-season sharpen,
    // then quietly re-render.
    refine(r._state).then(async () => {
      const better = await assemble(r._state);
      render(better, { isDemo });
      hint('Updated with the full remaining schedule');
    }).catch(() => {});
  } catch (e) {
    clear(); SESSION = null; FORCE_SETUP = true;
    renderGate(e.message);
  }
}

run();
