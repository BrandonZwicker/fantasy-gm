/* Calendar reminders.
 *
 * The deployed site has no server, so it cannot poll the league or send you
 * anything while the page is closed. What it can do is hand your calendar the
 * schedule: a subscribable .ics with an alarm before every waiver run and every
 * kickoff, timed to your league's own settings. Your phone does the reminding.
 *
 * The Python version can do real scheduled monitoring — see .github/workflows.
 */

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
                   + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
const esc = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');

// Sleeper stores waiver day as 0 = Tuesday … 6 = Monday.
const WAIVER_DAY_TO_JS = [2, 3, 4, 5, 6, 0, 1];

export const LEAD_TIMES = [
  { id: '1h',  label: '1 hour before',  minutes: 60 },
  { id: '3h',  label: '3 hours before', minutes: 180 },
  { id: '12h', label: '12 hours before', minutes: 720 },
  { id: '24h', label: 'A day before',   minutes: 1440 },
];

export const EVENT_KINDS = [
  { id: 'waivers', label: 'Waiver deadline', hint: 'before claims process' },
  { id: 'kickoff', label: 'Lineup lock',     hint: 'before Sunday kickoff' },
  { id: 'deadline', label: 'Trade deadline', hint: 'once, near the end' },
];

/** Next occurrence of a weekday at a local hour, on or after `from`. */
function nextWeekday(from, jsDay, hour) {
  const d = new Date(from);
  d.setHours(hour, 0, 0, 0);
  let delta = (jsDay - d.getDay() + 7) % 7;
  if (delta === 0 && d <= from) delta = 7;
  d.setDate(d.getDate() + delta);
  return d;
}

/**
 * Build the .ics text.
 * `weeksAhead` controls how far out the series runs; `kinds` and `leadMinutes`
 * are the user's choices.
 */
export function buildICS(report, { kinds, leadMinutes, weeksAhead = 16 } = {}) {
  const chosen = new Set(kinds && kinds.length ? kinds : ['waivers', 'kickoff']);
  const lead = leadMinutes || 180;
  const league = (report.league_name || 'Fantasy').trim();
  const url = report.league_id && !report.league_id.startsWith('EXAMPLE')
    ? `https://sleeper.com/leagues/${report.league_id}` : '';

  const now = new Date();
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'CALSCALE:GREGORIAN',
    'PRODID:-//Fantasy GM//EN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(league)} reminders`,
    'X-WR-TIMEZONE:UTC',
  ];

  let uid = 0;
  const push = (start, summary, desc) => {
    const end = new Date(start.getTime() + 15 * 60000);
    lines.push(
      'BEGIN:VEVENT',
      `UID:fgm-${Date.now()}-${uid++}@fantasy-gm`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${esc(summary)}`,
      `DESCRIPTION:${esc(desc + (url ? `\n\nOpen league: ${url}` : ''))}`,
      ...(url ? [`URL:${url}`] : []),
      'BEGIN:VALARM', 'ACTION:DISPLAY',
      `TRIGGER:-PT${lead}M`,
      `DESCRIPTION:${esc(summary)}`,
      'END:VALARM',
      'END:VEVENT',
    );
  };

  const waiverDay = WAIVER_DAY_TO_JS[(report.waiver_day_of_week ?? 2) % 7];
  const startWeek = report.week || 1;
  const lastWeek = Math.min(18, startWeek + weeksAhead);

  for (let i = 0; i < lastWeek - startWeek + 1; i++) {
    const anchor = new Date(now.getTime() + i * 7 * 86400000);
    if (chosen.has('waivers')) {
      // Waivers process ~3am; the useful moment is the evening before.
      const run = nextWeekday(anchor, waiverDay, 3);
      push(run, `Waivers process — ${league}`,
        report.uses_faab
          ? 'Submit FAAB claims before this. Fantasy GM has your bids ready.'
          : 'Submit waiver claims before this. Fantasy GM has your targets ready.');
    }
    if (chosen.has('kickoff')) {
      const kick = nextWeekday(anchor, 0, 13);   // Sunday ~1pm local
      push(kick, `Lineups lock — ${league}`,
        'Last chance to fix your starters. Check Fantasy GM for start/sit moves.');
    }
  }

  if (chosen.has('deadline') && report.deadlines?.length) {
    const wk = Number(String(report.deadlines[0]).match(/week (\d+)/i)?.[1]);
    if (wk && wk > startWeek) {
      const when = new Date(now.getTime() + (wk - startWeek) * 7 * 86400000);
      when.setHours(12, 0, 0, 0);
      push(when, `Trade deadline — ${league}`,
        'Last chance to trade. Check Fantasy GM for offers worth making.');
    }
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

export function downloadICS(report, opts) {
  const blob = new Blob([buildICS(report, opts)], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(report.league_name || 'fantasy').trim().replace(/\W+/g, '-').toLowerCase()}-reminders.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
