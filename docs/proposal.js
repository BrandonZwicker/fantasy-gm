/* Trade analysis card. Numbers only, no pitch, since a canned script reads
 * like one. Shows both rosters because only mutual-gain deals get proposed.
 */

import { optimize, replacementLevels, vor } from './engine.js';

const r1 = (x) => Math.round(x * 10) / 10;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function positionCounts(state, team) {
  const out = {};
  for (const pid of team.activePlayers()) {
    const p = state.players.get(pid);
    if (p) out[p.position] = (out[p.position] || 0) + 1;
  }
  return out;
}

function startCounts(state, lineup) {
  const out = {};
  for (const s of lineup.slots) {
    if (!s.player_id) continue;
    const p = state.players.get(s.player_id);
    if (p) out[p.position] = (out[p.position] || 0) + 1;
  }
  return out;
}

const swap = (pts, out, inn, src) => {
  const n = { ...pts };
  for (const p of out) delete n[p];
  for (const p of inn) n[p] = src[p] || 0;
  return n;
};

/** Both rosters, before and after, in numbers. `trade.send` is what they receive. */
export function buildCase(state, trade, ros) {
  const rules = state.rules;
  const them = state.teams[trade.partner_roster_id];
  const me = state.me;
  if (!them || !me) return null;

  const weeks = Math.max(1, state.weeksRemaining);

  // Rank every player within his own position, which is the unit fantasy
  // managers actually think in. "RB8" lands harder than "154 projected points".
  const ranks = {};
  const byPos = {};
  for (const pid in ros) {
    const p = state.players.get(pid);
    if (!p || !p.position || ros[pid] <= 0) continue;
    (byPos[p.position] ||= []).push([pid, ros[pid]]);
  }
  for (const pos in byPos) {
    byPos[pos].sort((a, b) => b[1] - a[1]);
    byPos[pos].forEach(([pid], i) => { ranks[pid] = i + 1; });
  }

  // Value over replacement: what he is worth against the freely available
  // alternative at his position, under this league's scoring.
  const levels = replacementLevels(rules, ros, state.players);
  const vors = vor(ros, state.players, levels);

  const detail = (pid) => {
    const p = state.players.get(pid);
    const total = ros[pid] || 0;
    return { pid, name: p?.name || pid, position: p?.position || '?',
             team: p?.team || '', ros: r1(total),
             perWeek: r1(total / weeks),
             rank: ranks[pid] ? `${p?.position || ''}${ranks[pid]}` : null,
             vor: r1(vors[pid] || 0) };
  };

  // Their side.
  const theirPts = state.rosterProjection(them, ros);
  const theirPos = state.positionsMap(theirPts);
  const theirBefore = optimize(rules, theirPts, theirPos);
  const theirAfterPts = swap(theirPts, trade.receive, trade.send, ros);
  const theirAfterPos = { ...theirPos };
  for (const pid of trade.send) {
    const p = state.players.get(pid);
    if (p) theirAfterPos[pid] = p.position;
  }
  const theirAfter = optimize(rules, theirAfterPts, theirAfterPos);

  // Your side.
  const myPts = state.rosterProjection(me, ros);
  const myPos = state.positionsMap(myPts);
  const myBefore = optimize(rules, myPts, myPos);
  const myAfterPts = swap(myPts, trade.send, trade.receive, ros);
  const myAfterPos = { ...myPos };
  for (const pid of trade.receive) {
    const p = state.players.get(pid);
    if (p) myAfterPos[pid] = p.position;
  }
  const myAfter = optimize(rules, myAfterPts, myAfterPos);

  // Where the pieces land, and who loses a slot as a result.
  const beforeIds = new Set(theirBefore.starterIds());
  const afterIds = new Set(theirAfter.starterIds());
  const outgoing = new Set(trade.receive);
  const lands = trade.send.map(pid => {
    const s = theirAfter.slots.find(x => x.player_id === pid);
    return { ...detail(pid), slot: s ? s.slot : null };
  });

  const displacedIds = [...beforeIds].filter(x => !afterIds.has(x) && !outgoing.has(x));
  const displaced = displacedIds.map(pid => detail(pid).name);

  // The upgrade that actually matters to them: not the roster total, but who
  // stops starting and by how much, per week.
  const slotUpgrade = (() => {
    const inc = lands.find(l => l.slot);
    if (!inc) return null;
    const outPlayer = displacedIds.length ? detail(displacedIds[0]) : null;
    if (!outPlayer) return null;
    return { slot: inc.slot, in: inc, out: outPlayer,
             perWeek: r1(inc.perWeek - outPlayer.perWeek) };
  })();

  // Positional depth on their roster, before and after.
  const have = positionCounts(state, them);
  const starts = startCounts(state, theirBefore);
  const delta = { ...have };
  for (const pid of trade.receive) {
    const p = state.players.get(pid);
    if (p) delta[p.position] = (delta[p.position] || 0) - 1;
  }
  for (const pid of trade.send) {
    const p = state.players.get(pid);
    if (p) delta[p.position] = (delta[p.position] || 0) + 1;
  }
  const touched = new Set([...trade.send, ...trade.receive]
    .map(pid => state.players.get(pid)?.position).filter(Boolean));
  const depth = [...touched].map(pos => ({
    position: pos, before: have[pos] || 0, after: delta[pos] || 0,
    starts: starts[pos] || 0,
  }));

  return {
    partner: them.label,
    myTeam: me.label,
    league: rules.name.trim(),
    week: state.currentWeek,
    theyGet: trade.send.map(detail),
    theyGive: trade.receive.map(detail),
    weeks,
    theirBefore: r1(theirBefore.total), theirAfter: r1(theirAfter.total),
    theirGain: r1(theirAfter.total - theirBefore.total),
    theirPerWeek: r1((theirAfter.total - theirBefore.total) / weeks),
    myBefore: r1(myBefore.total), myAfter: r1(myAfter.total),
    myGain: r1(myAfter.total - myBefore.total),
    myPerWeek: r1((myAfter.total - myBefore.total) / weeks),
    slotUpgrade,
    valueRatio: trade.value_ratio,
    acceptance: trade.acceptance,
    lands, displaced, depth,
    // Whether each piece they send is actually in their starting lineup.
    givingUpStarter: trade.receive.some(pid => beforeIds.has(pid)),
  };
}

/** Short factual points. Talking material, not a script. */
export function buildKeyPoints(c) {
  const pts = [];
  const get = c.theyGet.map(p => p.name).join(' + ');
  const give = c.theyGive.map(p => p.name).join(' + ');
  const tag = (p) => `${p.name} is ${p.rank || p.position} rest of season, ${p.perWeek}/wk, ${p.vor >= 0 ? '+' : ''}${p.vor} over replacement`;

  pts.push(`${c.partner} gets ${get}, ${c.myTeam} gets ${give}`);
  for (const p of c.theyGet) pts.push(tag(p));
  for (const p of c.theyGive) pts.push(tag(p));

  if (c.slotUpgrade) {
    const u = c.slotUpgrade;
    pts.push(`${c.partner} ${u.slot} goes from ${u.out.name} at ${u.out.perWeek}/wk to `
      + `${u.in.name} at ${u.in.perWeek}/wk, ${u.perWeek >= 0 ? '+' : ''}${u.perWeek} a week in that slot`);
  }
  pts.push(`${c.partner} starting lineup ${c.theirGain >= 0 ? '+' : ''}${c.theirGain} over ${c.weeks} weeks, `
    + `${c.theirPerWeek >= 0 ? '+' : ''}${c.theirPerWeek} a week`);
  pts.push(`${c.myTeam} ${c.myGain >= 0 ? '+' : ''}${c.myGain} over the same stretch, `
    + `${c.myPerWeek >= 0 ? '+' : ''}${c.myPerWeek} a week`);

  for (const d of c.depth) {
    pts.push(`${c.partner} ${d.position} depth ${d.before} → ${d.after}, starting ${d.starts}`);
  }
  pts.push(c.givingUpStarter
    ? `${give} currently starts for ${c.partner}, so this is not spare depth`
    : `${give} is not in the ${c.partner} starting lineup`);
  pts.push(`Value sent / received ${c.valueRatio}x${c.valueRatio >= 0.9 && c.valueRatio <= 1.1 ? ', roughly even' : ''}`);
  pts.push(`Scored on ${c.league} settings, not generic PPR`);
  return pts;
}

/* ---------------- the card ---------------- */

const F = 'Inter,Segoe UI,-apple-system,sans-serif';
const INK = '#17181D', DIM = '#8B8F9A', MID = '#4A4D57';
const GAIN = '#0B8F63', LINE = '#E7E3DC';

export function buildSVG(c) {
  const W = 980, L = 56, R = W - 56;
  // Laid out with a running cursor rather than hand-placed coordinates, which
  // is how the lineup bars ended up overlapping the depth rows.
  let y = 0;
  const out = [];
  const text = (x, yy, s, o = {}) =>
    `<text x="${x}" y="${yy}" font-family="${F}" font-size="${o.size || 15}"` +
    ` font-weight="${o.weight || 400}" fill="${o.fill || INK}"` +
    (o.anchor ? ` text-anchor="${o.anchor}"` : '') +
    (o.spacing ? ` letter-spacing="${o.spacing}"` : '') +
    `>${esc(s)}</text>`;
  const rule = () => { y += 18; out.push(`<line x1="${L}" y1="${y}" x2="${R}" y2="${y}" stroke="${LINE}"/>`); y += 6; };
  const label = (s) => { y += 26; out.push(text(L, y, s, { size: 11, weight: 700, spacing: 1.5, fill: DIM })); };

  // Header
  y = 48;
  out.push(text(L, y, `${c.partner}  ⇄  ${c.myTeam}`, { size: 20, weight: 700 }));
  out.push(text(R, y, `${c.league} · week ${c.week}`, { size: 13, fill: DIM, anchor: 'end' }));
  rule();

  // Who moves
  const colTop = y + 26;
  out.push(text(L, colTop, `${c.partner.toUpperCase()} GETS`, { size: 11, weight: 700, spacing: 1.5, fill: DIM }));
  out.push(text(520, colTop, `${c.myTeam.toUpperCase()} GETS`, { size: 11, weight: 700, spacing: 1.5, fill: DIM }));
  const block = (x, list) => list.forEach((p, i) => {
    const top = colTop + 34 + i * 74;
    out.push(text(x, top, p.name, { size: 21, weight: 600 }));
    out.push(text(x, top + 21, `${p.rank || p.position} · ${p.team}`, { size: 14, weight: 600, fill: MID }));
    out.push(text(x, top + 41, `${p.perWeek}/wk · ${p.ros} total · ${p.vor >= 0 ? '+' : ''}${p.vor} vs replacement`,
      { size: 12.5, fill: DIM }));
  });
  block(L, c.theyGet);
  block(520, c.theyGive);
  y = colTop + 34 + Math.max(c.theyGet.length, c.theyGive.length) * 74 - 26;
  rule();

  // Lineup effect
  label('PROJECTED STARTING LINEUP, REST OF SEASON');
  const barMax = Math.max(Math.abs(c.theirGain), Math.abs(c.myGain), 1);
  const bar = (name, before, after, gain, perWeek, fill) => {
    y += 30;
    const w = Math.max(4, (Math.abs(gain) / barMax) * 150);
    out.push(text(L, y, name, { size: 14, weight: 600, fill: MID }));
    out.push(text(200, y, `${before} → ${after}`, { size: 14, fill: MID }));
    out.push(`<rect x="340" y="${y - 14}" width="${w}" height="18" rx="5" fill="${fill}"/>`);
    out.push(text(348 + w, y, `${gain >= 0 ? '+' : ''}${gain}`, { size: 14, weight: 700, fill }));
    out.push(text(R, y, `${perWeek >= 0 ? '+' : ''}${perWeek} / wk`,
      { size: 14, weight: 700, fill, anchor: 'end' }));
  };
  bar(c.partner, c.theirBefore, c.theirAfter, c.theirGain, c.theirPerWeek, GAIN);
  bar(c.myTeam, c.myBefore, c.myAfter, c.myGain, c.myPerWeek, '#9AA0A8');
  rule();

  // Positional depth on their roster
  label(`${c.partner.toUpperCase()} POSITIONAL DEPTH`);
  for (const d of c.depth) {
    y += 26;
    out.push(text(L, y, d.position, { size: 14, weight: 600 }));
    out.push(text(120, y, `${d.before} → ${d.after} on roster`, { size: 14, fill: MID }));
    out.push(text(320, y, `${d.starts} start`, { size: 14, fill: DIM }));
  }
  rule();

  // The slot upgrade, which is the most concrete number on the card.
  if (c.slotUpgrade) {
    const u = c.slotUpgrade;
    label(`${c.partner.toUpperCase()} ${u.slot} SLOT`);
    y += 28;
    out.push(text(L, y, `${u.out.name} ${u.out.perWeek}/wk`, { size: 15, fill: MID }));
    out.push(text(L + 210, y, '→', { size: 15, fill: DIM }));
    out.push(text(L + 240, y, `${u.in.name} ${u.in.perWeek}/wk`, { size: 15, weight: 600 }));
    out.push(text(R, y, `${u.perWeek >= 0 ? '+' : ''}${u.perWeek} / wk in that slot`,
      { size: 15, weight: 700, fill: GAIN, anchor: 'end' }));
    rule();
  }
  y += 22;
  out.push(text(L, y, `value sent / received ${c.valueRatio}x   ·   `
    + `${c.givingUpStarter ? `${c.partner} give up a starter` : `${c.partner} give up bench depth`}`
    + `   ·   scored on league settings`, { size: 12, fill: DIM }));
  y += 28;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}">
<rect width="${W}" height="${y}" fill="#FFFFFF"/>
${out.join('\n')}
</svg>`;
}

export function svgToPng(svg, scale = 2) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.width * scale; cv.height = img.height * scale;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      cv.toBlob(b => b ? resolve(b) : reject(new Error('could not render')), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not render')); };
    img.src = url;
  });
}
