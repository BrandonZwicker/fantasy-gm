/* League-wide adds and drops, used only to break near-ties.
 * Projections lag, roster moves don't. Counts are raw rather than per-roster
 * rates, and adds are capped by availability, so drops are the cleaner signal.
 */

const BASE = 'https://api.sleeper.app/v1/players/nfl/trending';

// Below this a count is churn rather than a message.
const NOISE_FLOOR = 4000;
// Above this the league is clearly abandoning someone.
const STRONG = 25000;

export async function fetchSentiment(hours = 24, limit = 200) {
  const out = new Map();
  const pull = async (kind) => {
    try {
      const r = await fetch(`${BASE}/${kind}?lookback_hours=${hours}&limit=${limit}`);
      return r.ok ? await r.json() : [];
    } catch { return []; }
  };
  const [adds, drops] = await Promise.all([pull('add'), pull('drop')]);
  for (const t of adds || []) {
    const k = String(t.player_id);
    out.set(k, { ...(out.get(k) || { adds: 0, drops: 0 }), adds: t.count });
  }
  for (const t of drops || []) {
    const k = String(t.player_id);
    out.set(k, { ...(out.get(k) || { adds: 0, drops: 0 }), drops: t.count });
  }
  for (const [k, v] of out) {
    v.adds ||= 0; v.drops ||= 0;
    v.net = v.adds - v.drops;
    out.set(k, { ...v, ...verdictFor(v) });
  }
  return out;
}

function verdictFor({ adds, drops, net }) {
  const mag = Math.abs(net);
  if (mag < NOISE_FLOOR) return { direction: 0, verdict: 'no clear signal', strength: 0 };
  const strength = Math.min(1, mag / STRONG);
  if (net < 0) {
    return {
      direction: -1, strength,
      verdict: mag >= STRONG
        ? `being dropped hard, ${drops.toLocaleString()} drops in 24h`
        : `drifting out of lineups, ${drops.toLocaleString()} drops in 24h`,
    };
  }
  return {
    direction: 1, strength,
    verdict: mag >= STRONG
      ? `being added everywhere, ${adds.toLocaleString()} adds in 24h`
      : `getting picked up, ${adds.toLocaleString()} adds in 24h`,
  };
}

export const sentimentOf = (map, pid) =>
  (map && map.get) ? (map.get(String(pid)) || null) : null;

/**
 * Decide a near-tie on evidence the projection has not absorbed.
 * Returns null when nothing separates them, which is itself an answer.
 */
export function breakTie({ inSent, outSent, inProb, outProb, inName, outName }) {
  const reasons = [];
  let score = 0;

  // Availability first. A player who might not suit up loses a coin flip.
  const pi = inProb == null ? 1 : inProb;
  const po = outProb == null ? 1 : outProb;
  if (Math.abs(pi - po) > 0.1) {
    const favoursIn = pi > po;
    score += favoursIn ? 1.5 : -1.5;
    reasons.push(favoursIn
      ? `${inName} is the safer bet to actually play, ${Math.round(pi * 100)}% against ${Math.round(po * 100)}%`
      : `${outName} is the safer bet to actually play, ${Math.round(po * 100)}% against ${Math.round(pi * 100)}%`);
  }

  // Then what the league is doing with each of them.
  const dIn = inSent?.direction || 0;
  const dOut = outSent?.direction || 0;
  if (dIn !== dOut) {
    if (dIn > 0 || dOut < 0) {
      score += 1;
      if (dIn > 0) reasons.push(`${inName} is ${inSent.verdict}`);
      if (dOut < 0) reasons.push(`${outName} is ${outSent.verdict}`);
    }
    if (dIn < 0 || dOut > 0) {
      score -= 1;
      if (dIn < 0) reasons.push(`${inName} is ${inSent.verdict}`);
      if (dOut > 0) reasons.push(`${outName} is ${outSent.verdict}`);
    }
  }

  if (!reasons.length) return null;
  return {
    favours: score > 0 ? 'in' : score < 0 ? 'out' : 'neither',
    reasons,
  };
}
