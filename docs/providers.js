/* Fantasy platform support.
 *
 * Sleeper works from the browser because its API is unauthenticated and sends
 * `access-control-allow-origin: *`. Yahoo does not: its fantasy API returns no
 * CORS headers at all (even an OPTIONS preflight answers 401 with none), and
 * its OAuth2 token exchange requires a client secret that cannot live in
 * public JavaScript. Yahoo therefore needs a small server-side proxy to hold
 * the secret and re-emit responses with CORS headers. The shape below is what
 * such a proxy would plug into.
 */

export const PLATFORMS = {
  sleeper: {
    id: 'sleeper',
    name: 'Sleeper',
    available: true,
    note: 'Public API, no login needed — just your username.',
    async findLeagues(handle, Sleeper) {
      const user = await Sleeper.user(handle);
      if (!user) throw new Error(`No Sleeper user named “${handle}”`);
      const season = (await Sleeper.state()).season;
      const leagues = (await Sleeper.userLeagues(user.user_id, season)) || [];
      return {
        userId: user.user_id, season,
        leagues: leagues.map(l => ({ league_id: l.league_id, name: l.name,
                                     teams: l.total_rosters })),
      };
    },
  },

  yahoo: {
    id: 'yahoo',
    name: 'Yahoo',
    available: false,
    // Surfaced in the UI so the limitation is explained rather than hidden.
    note: 'Needs a server-side proxy — Yahoo blocks browser requests and its '
        + 'login requires a private key that cannot be shipped in a static site.',
    detail: [
      'Yahoo\'s fantasy API sends no `access-control-allow-origin` header, so a '
      + 'browser refuses the request before it is even sent — being logged in '
      + 'does not help.',
      'Yahoo also requires OAuth2, whose token exchange needs a client secret. '
      + 'Anything shipped to a static site is public, so the secret would leak.',
      'Both are solved by a ~100-line proxy (a Cloudflare Worker or Vercel '
      + 'function) that stores the secret, performs the OAuth handshake, and '
      + 'forwards API responses with CORS headers. The engine itself is '
      + 'platform-agnostic: it needs roster, scoring and projection data in the '
      + 'shape this module defines, wherever that comes from.',
    ],
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
