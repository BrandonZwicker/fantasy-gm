/* Kickoff times. A swap closes at the earlier of the two players' kickoffs,
 * since whoever plays first locks first. Inactives land ~90 min before.
 */

const SCOREBOARD =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

// ESPN's default scoreboard returns whatever week it considers current, which
// is not necessarily the week we are projecting. Sleeper rolls its week over on
// the Tuesday, so on a Tuesday ESPN still serves last week's finished games
// while we are already scoring the week ahead. Reading those as "locked" froze
// an entire upcoming lineup. The week is therefore always requested explicitly.
const urlFor = (season, week) =>
  (season && week)
    ? `${SCOREBOARD}?seasontype=2&week=${week}&dates=${season}`
    : SCOREBOARD;

export const INACTIVES_LEAD_MIN = 90;

/** Map of team abbreviation -> { kickoff: Date, opponent, started, final }. */
export async function fetchKickoffs(season, week) {
  const out = new Map();
  let data;
  try {
    const r = await fetch(urlFor(season, week));
    if (!r.ok) return out;
    data = await r.json();
  } catch {
    return out;     // schedule is an enhancement, never block on it
  }

  // If ESPN hands back a different week than we asked for, we cannot tell which
  // games these are. Returning nothing leaves every player movable, which is the
  // safe direction to be wrong in: it costs a stale suggestion, not a lost week.
  const got = data.week?.number;
  if (week && got && Number(got) !== Number(week)) return out;
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
