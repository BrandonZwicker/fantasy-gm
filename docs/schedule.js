/* Kickoff times, so we can say when a decision actually expires.
 *
 * A swap between two players closes at the EARLIER of their two kickoffs —
 * whoever plays first locks first, and after that the other one can't be moved
 * into his slot. Telling you "before Sunday kickoff" is useless when one of the
 * pair plays Thursday night.
 *
 * Inactives are published about 90 minutes before kickoff, so that is the last
 * useful moment to check a questionable player's status.
 */

const SCOREBOARD =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

export const INACTIVES_LEAD_MIN = 90;

/** Map of team abbreviation -> { kickoff: Date, opponent, started, final }. */
export async function fetchKickoffs() {
  const out = new Map();
  let data;
  try {
    const r = await fetch(SCOREBOARD);
    if (!r.ok) return out;
    data = await r.json();
  } catch {
    return out;     // schedule is an enhancement, never block on it
  }
  for (const ev of data.events || []) {
    const comp = (ev.competitions || [])[0];
    if (!comp) continue;
    const kickoff = new Date(ev.date);
    const state = comp.status?.type?.state || '';
    const teams = (comp.competitors || []).map(c => c.team?.abbreviation).filter(Boolean);
    for (const t of teams) {
      out.set(t.toUpperCase(), {
        kickoff,
        opponent: teams.find(x => x !== t) || null,
        started: state !== 'pre',
        final: state === 'post',
      });
    }
  }
  return out;
}

const fmt = (d) => d.toLocaleString(undefined, {
  weekday: 'short', hour: 'numeric', minute: '2-digit',
});

/**
 * When a swap between these players closes, and when to take a last look.
 * Returns null when we don't know both kickoffs.
 */
export function swapDeadline(kickoffs, teamA, teamB) {
  const a = teamA ? kickoffs.get(String(teamA).toUpperCase()) : null;
  const b = teamB ? kickoffs.get(String(teamB).toUpperCase()) : null;
  const games = [a, b].filter(Boolean);
  if (!games.length) return null;

  // The binding constraint is whichever of the two plays first.
  const first = games.reduce((m, g) => (g.kickoff < m.kickoff ? g : m));
  const check = new Date(first.kickoff.getTime() - INACTIVES_LEAD_MIN * 60000);
  const now = new Date();
  const hoursLeft = (first.kickoff - now) / 3.6e6;

  return {
    locksAt: first.kickoff,
    checkBy: check,
    locked: first.started,
    hoursLeft,
    // Which side is the constraint, so we can name it.
    bindingTeam: (a && a.kickoff <= (b ? b.kickoff : a.kickoff)) ? teamA : teamB,
    label: first.started
      ? 'already locked'
      : `locks ${fmt(first.kickoff)} · last check ${fmt(check)}`,
  };
}
