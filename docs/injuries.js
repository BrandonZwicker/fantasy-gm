/* Injury intelligence.
 *
 * A "Questionable" tag covers everything from "full practice, expected to play"
 * to "ACL surgery". Sleeper only gives the tag and a body part, which is not
 * enough to decide whether to start someone — and inventing a flat discount for
 * the tag was worse than useless, because it silently moved projections away
 * from the number the app shows.
 *
 * ESPN publishes a per-team injury report with a narrative note, and it sends
 * `access-control-allow-origin: *`, so the browser can read it directly. The
 * notes are formulaic enough to classify: practice participation and a handful
 * of stock phrases carry most of the signal. We turn that into a probability
 * the player suits up, and we always show the note so the call stays with you.
 */

const ESPN_INJURIES =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';

/** Phrases that move the estimate, strongest first. */
const SIGNALS = [
  // Effectively ruled out.
  [/\b(season[- ]ending|out for the (season|year)|torn (acl|achilles)|placed on ir|injured reserve)\b/i, 0.00, 'out for the season'],
  [/\b(ruled out|will (not|miss)|has been ruled out|declared out)\b/i, 0.02, 'ruled out'],
  [/\b(underwent|scheduled for) surgery\b|\bsurgery\b/i, 0.05, 'surgery'],
  [/\b(did not practice|dnp|missed practice|no practice)\b/i, 0.30, 'did not practice'],
  // Genuinely uncertain.
  [/\b(game[- ]time decision|coin flip|true toss[- ]up)\b/i, 0.50, 'game-time decision'],
  [/\blimited (participation|practice)\b|\bpractised? on a limited\b/i, 0.62, 'limited practice'],
  // Trending up.
  [/\b(full participation|full practice|practiced fully|no limitations)\b/i, 0.88, 'full practice'],
  [/\b(expected to (play|suit up|start|go)|should (play|suit up|be available)|on track to (play|return)|good to go|cleared to (play|return))\b/i, 0.90, 'expected to play'],
  [/\b(returned to practice|activated|off the injury report)\b/i, 0.85, 'back at practice'],
];

/** Baseline from the designation alone, before reading the note. */
// "Active" means he is playing — no haircut, so his number matches the app
// exactly. Only genuinely uncertain designations are adjusted at all.
const BASE_FROM_STATUS = {
  out: 0.02, doubtful: 0.25, questionable: 0.60,
  probable: 1.0, active: 1.0, injured_reserve: 0.0, suspension: 0.0,
};

const normalize = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
  .replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

// ESPN groups by team display name and gives no abbreviation, so the index is
// keyed on the player's name alone. NFL names are near-unique; on the rare
// collision the more recent entry wins.
export const injuryKey = (name) => normalize(name);

/**
 * Read a report entry into a probability the player suits up, plus the reason.
 *
 * ESPN's own designation is authoritative and the narrative only refines it.
 * That distinction matters: `longComment` often recounts history ("...following
 * surgery last season", "the Ravens released a statement..."), and letting those
 * phrases override the status benched genuinely active players. So the narrative
 * is only consulted where the designation is itself uncertain, and the recent,
 * formulaic `shortComment` is preferred over the long one.
 */
export function playProbability({ status, note, shortNote, bodyPart }) {
  const key = String(status || '').toLowerCase().replace(/[^a-z]/g, '_');
  const base = BASE_FROM_STATUS[key];

  // A definite designation settles it — in both directions.
  if (base != null && base <= 0.05) {
    return { probability: base, reason: `listed ${status}` };
  }
  if (base != null && base >= 0.98) {
    return { probability: base, reason: `listed ${status}` };
  }

  let p = base ?? 0.6;
  let reason = status ? `listed ${status}` : 'no designation';

  // Prefer the current, formulaic line; fall back to the long one.
  const text = `${shortNote || ''} ${shortNote ? '' : note || ''} ${bodyPart || ''}`;

  // Most severe match wins, so "ruled out" beats "full practice".
  let best = null;
  for (const [re, value, label] of SIGNALS) {
    if (re.test(text) && (best === null || value < best[0])) best = [value, label];
  }
  if (best) { [p, reason] = best; }

  // A structural injury outranks an uncertain tag: these do not play.
  if (/\b(acl|achilles|torn|ruptured)\b/i.test(`${bodyPart || ''} ${shortNote || ''}`)) {
    p = Math.min(p, 0.05);
    reason = 'structural injury';
  }
  return { probability: Math.max(0, Math.min(1, p)), reason };
}

/** Fetch and index ESPN's report. Returns a Map keyed by `injuryKey`. */
export async function fetchInjuryReport() {
  const out = new Map();
  let data;
  try {
    const r = await fetch(ESPN_INJURIES);
    if (!r.ok) return out;
    data = await r.json();
  } catch {
    return out;     // news is an enhancement; never block the report on it
  }
  for (const team of data.injuries || []) {
    const teamName = team.displayName || '';
    for (const item of team.injuries || []) {
      const name = item.athlete?.displayName;
      if (!name) continue;
      const long = item.longComment || '';
      const short = item.shortComment || '';
      const note = long || short;
      // The short form reads "Gillikin (groin) was a full participant…", so the
      // parenthetical is a reliable body part when ESPN gives no field for it.
      const bodyPart = (short.match(/\(([^)]{2,40})\)/) || [])[1] || '';
      const entry = {
        name, team: teamName, status: item.status || item.type?.description || '',
        note: long || short, shortNote: short,
        bodyPart, updated: item.date || null,
      };
      const { probability, reason } = playProbability(entry);
      const key = injuryKey(name);
      const prev = out.get(key);
      if (!prev || (entry.updated || '') >= (prev.updated || '')) {
        out.set(key, { ...entry, probability, reason });
      }
    }
  }
  return out;
}

export function lookupInjury(report, name) {
  if (!report || !report.size) return null;
  return report.get(injuryKey(name)) || null;
}
