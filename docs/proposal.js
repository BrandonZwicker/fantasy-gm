/* Trade proposal package.
 *
 * A trade only happens if the other manager says yes, and nobody says yes to a
 * wall of numbers about how much it helps you. This builds the case from THEIR
 * side: what their lineup looks like before and after, which hole it fills, and
 * what the swap is actually worth to them.
 *
 * Everything in here is computed from the same projections the rest of the app
 * uses. It does not overstate, and it does not hide that the trade helps you
 * too, because only mutual-gain trades get proposed in the first place and
 * pretending otherwise is how you lose someone's trust for the rest of a season.
 */

import { SLOT_ELIGIBILITY, optimize } from './engine.js';

const r1 = (x) => Math.round(x * 10) / 10;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** Positional counts on a roster, and how many of each actually start. */
function depth(state, team, ros) {
  const counts = {};
  for (const pid of team.activePlayers()) {
    const p = state.players.get(pid);
    if (p) counts[p.position] = (counts[p.position] || 0) + 1;
  }
  return counts;
}

function startersByPos(rules, lineup, state) {
  const out = {};
  for (const s of lineup.slots) {
    if (!s.player_id) continue;
    const p = state.players.get(s.player_id);
    if (p) out[p.position] = (out[p.position] || 0) + 1;
  }
  return out;
}

/**
 * Work out what the deal does to the partner's roster.
 * `trade.send` are the players they would receive.
 */
export function buildCase(state, trade, ros) {
  const rules = state.rules;
  const them = state.teams[trade.partner_roster_id];
  const me = state.me;
  if (!them || !me) return null;

  const theirPts = state.rosterProjection(them, ros);
  const theirPos = state.positionsMap(theirPts);
  const before = optimize(rules, theirPts, theirPos);

  const after = { ...theirPts };
  for (const pid of trade.receive) delete after[pid];      // they give these up
  for (const pid of trade.send) after[pid] = ros[pid] || 0; // they receive these
  const afterPos = { ...theirPos };
  for (const pid of trade.send) {
    const p = state.players.get(pid);
    if (p) afterPos[pid] = p.position;
  }
  const afterLineup = optimize(rules, after, afterPos);

  // Where the incoming players land in their lineup.
  const lands = trade.send.map(pid => {
    const slot = afterLineup.slots.find(s => s.player_id === pid);
    const p = state.players.get(pid);
    return { pid, name: p?.name || pid, position: p?.position || '?',
             slot: slot ? slot.slot : null, points: r1(ros[pid] || 0) };
  });

  // Who they lose out of their lineup. The players leaving in the trade are
  // obviously gone, so they are not "displaced" by anything.
  const beforeIds = new Set(before.starterIds());
  const afterIds = new Set(afterLineup.starterIds());
  const outgoing = new Set(trade.receive);
  const displaced = [...beforeIds]
    .filter(x => !afterIds.has(x) && !outgoing.has(x))
    .map(pid => state.players.get(pid)?.name).filter(Boolean);

  const theirDepth = depth(state, them, ros);
  const theirStarts = startersByPos(rules, before, state);

  // Whether each piece they give up is genuinely spare. Counting the position
  // is not enough: a team can be six deep at receiver and still be handing over
  // the one who starts every week. Calling that man "depth you can't use" is
  // both false and the fastest way to have a proposal ignored.
  const surplus = trade.receive.map(pid => {
    const p = state.players.get(pid);
    if (!p) return null;
    const have = theirDepth[p.position] || 0;
    const start = theirStarts[p.position] || 0;
    return {
      name: p.name, position: p.position, have, start,
      startsForThem: beforeIds.has(pid),
      spare: Math.max(0, have - start),
    };
  }).filter(Boolean);

  return {
    partner: them.label,
    partnerRecord: them.record,
    league: rules.name.trim(),
    theyGet: trade.send.map(p => state.players.get(p)?.name || p),
    theyGive: trade.receive.map(p => state.players.get(p)?.name || p),
    theirBefore: r1(before.total),
    theirAfter: r1(afterLineup.total),
    theirGain: r1(afterLineup.total - before.total),
    myGain: r1(trade.my_gain),
    lands, displaced, surplus,
    acceptance: trade.acceptance,
  };
}

/** A message they can paste straight into a league chat. */
export function buildMessage(c, myName) {
  const get = c.theyGet.join(' and ');
  const give = c.theyGive.join(' and ');
  const lines = [];

  lines.push(`hey, trade idea for you.`);
  lines.push('');
  lines.push(`you get ${get}, i get ${give}.`);
  lines.push('');

  // Only make the "spare depth" argument about a player who is actually spare.
  const benchPiece = c.surplus.find(s => !s.startsForThem && s.spare > 0);
  const starterPiece = c.surplus.find(s => s.startsForThem);
  if (benchPiece) {
    lines.push(`why it works on your side. you're ${benchPiece.have} deep at `
      + `${benchPiece.position} and only start ${benchPiece.start}, so ${benchPiece.name} `
      + `is depth you can't get on the field. you'd be trading from the one spot `
      + `where you have more than you can use.`);
  } else if (starterPiece) {
    lines.push(`why it works on your side. i know ${starterPiece.name} starts for you, `
      + `so this isn't me asking for a spare part. the case is that you're `
      + `${starterPiece.have} deep at ${starterPiece.position} and start `
      + `${starterPiece.start}, so someone steps into that slot straight away, `
      + `and what you get back is worth more than the drop-off.`);
  } else {
    lines.push(`why it works on your side. it's a straight upgrade to your starting `
      + `lineup rather than a depth move.`);
  }
  lines.push('');

  const landed = c.lands.filter(l => l.slot);
  if (landed.length) {
    const l = landed[0];
    lines.push(`${l.name} goes straight into your ${l.slot}`
      + (c.displaced.length ? ` over ${c.displaced[0]}` : '')
      + `, and your projected starting lineup goes from ${c.theirBefore} to `
      + `${c.theirAfter} between now and playoffs. that's about `
      + `${Math.abs(c.theirGain)} points.`);
    lines.push('');
  }

  lines.push(`and yes it helps me too, i'm short at that spot, which is the only `
    + `reason i'm asking. figured that's better than pretending it's charity.`);
  lines.push('');
  lines.push(`numbers are run on our league's actual scoring, not generic ppr. `
    + `happy to send the breakdown if you want it.`);
  lines.push('');
  lines.push(`let me know.`);
  return lines.join('\n');
}

/** A shareable card. Framed in the second person, because they are the reader. */
export function buildSVG(c) {
  const W = 1000, H = 560;
  const maxGain = Math.max(Math.abs(c.theirGain), Math.abs(c.myGain), 1);
  const barW = (v) => Math.max(6, (Math.abs(v) / maxGain) * 300);
  const col = (arr) => arr.map((n, i) =>
    `<text x="0" y="${i * 34}" font-family="Inter,Segoe UI,sans-serif" font-size="25"
       font-weight="600" fill="#17181D">${esc(n)}</text>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#F6F4F0"/>
  <rect x="32" y="32" width="${W - 64}" height="${H - 64}" rx="18" fill="#FFFFFF"/>

  <text x="68" y="92" font-family="Georgia,serif" font-size="30" fill="#17181D">Trade proposal</text>
  <text x="68" y="120" font-family="Inter,Segoe UI,sans-serif" font-size="15"
        fill="#8B8F9A">${esc(c.league)} · for ${esc(c.partner)}</text>

  <line x1="68" y1="146" x2="${W - 68}" y2="146" stroke="#E7E3DC" stroke-width="1"/>

  <text x="68" y="186" font-family="Inter,Segoe UI,sans-serif" font-size="12"
        font-weight="700" letter-spacing="1.6" fill="#0B8F63">YOU GET</text>
  <g transform="translate(68,222)">${col(c.theyGet)}</g>

  <text x="540" y="186" font-family="Inter,Segoe UI,sans-serif" font-size="12"
        font-weight="700" letter-spacing="1.6" fill="#B4721A">YOU GIVE</text>
  <g transform="translate(540,222)">${col(c.theyGive)}</g>

  <text x="470" y="232" font-family="Inter,Segoe UI,sans-serif" font-size="26" fill="#8B8F9A">→</text>

  <line x1="68" y1="330" x2="${W - 68}" y2="330" stroke="#E7E3DC" stroke-width="1"/>

  <text x="68" y="368" font-family="Inter,Segoe UI,sans-serif" font-size="12"
        font-weight="700" letter-spacing="1.6" fill="#8B8F9A">PROJECTED STARTING LINEUP, REST OF SEASON</text>

  <text x="68" y="410" font-family="Inter,Segoe UI,sans-serif" font-size="16"
        font-weight="600" fill="#17181D">Your lineup</text>
  <rect x="230" y="394" width="${barW(c.theirGain)}" height="22" rx="6" fill="#0B8F63"/>
  <text x="${238 + barW(c.theirGain)}" y="411" font-family="Inter,Segoe UI,sans-serif"
        font-size="16" font-weight="700" fill="#0B8F63">+${Math.abs(c.theirGain)}</text>

  <text x="68" y="456" font-family="Inter,Segoe UI,sans-serif" font-size="16"
        font-weight="600" fill="#4A4D57">My lineup</text>
  <rect x="230" y="440" width="${barW(c.myGain)}" height="22" rx="6" fill="#B6B8BF"/>
  <text x="${238 + barW(c.myGain)}" y="457" font-family="Inter,Segoe UI,sans-serif"
        font-size="16" font-weight="700" fill="#8B8F9A">+${Math.abs(c.myGain)}</text>

  <text x="68" y="508" font-family="Inter,Segoe UI,sans-serif" font-size="13" fill="#8B8F9A">
    ${esc(c.theyGet[0] || '')} slots into your ${esc((c.lands.find(l => l.slot) || {}).slot || 'lineup')}. Scored on this league's own settings, not generic PPR.
  </text>
</svg>`;
}

/** Rasterise for pasting into a chat that will not take an SVG. */
export function svgToPng(svg, scale = 2) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.width * scale; cv.height = img.height * scale;
      const ctx = cv.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      cv.toBlob(b => b ? resolve(b) : reject(new Error('could not render')), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not render')); };
    img.src = url;
  });
}
