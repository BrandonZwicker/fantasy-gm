/* Fantasy platform support.
 *
 * Sleeper works from the browser because its API is unauthenticated and sends
 * `access-control-allow-origin: *`. Other platforms (Yahoo, ESPN) would need a
 * server-side proxy: they send no CORS headers, and their OAuth flows require a
 * client secret that cannot live in public JavaScript. The shape below is what
 * such a proxy would plug into — the engine only ever sees rosters, scoring
 * settings and projections, so adding a platform is a provider, not a rewrite.
 */

export const PLATFORMS = {
  sleeper: {
    id: 'sleeper',
    name: 'Sleeper',
    available: true,
    async findLeagues(handle, Sleeper) {
      const user = await Sleeper.user(handle);
      if (!user) throw new Error(`No Sleeper user named “${handle}”`);
      const season = (await Sleeper.state()).season;
      const leagues = (await Sleeper.userLeagues(user.user_id, season)) || [];
      return {
        userId: user.user_id,
        season,
        leagues: leagues.map(l => ({
          league_id: l.league_id, name: l.name, teams: l.total_rosters,
        })),
      };
    },
  },
};

/** The bundled example league: real players and projections, invented managers. */
export const EXAMPLE = {
  file: './demo-league.json',
  async load() {
    const r = await fetch(this.file);
    if (!r.ok) throw new Error('Could not load the example league');
    const d = await r.json();
    return {
      source: { league: d.league, rosters: d.rosters, users: d.users },
      league_id: d.league.league_id,
      league_name: d.league.name,
      user_id: d.demo_user_id,
    };
  },
};
