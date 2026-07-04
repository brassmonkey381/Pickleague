// Pickleague toolbox config — consumed by the foundation engine
// (shared/toolbox/server.mjs). Domain-specific keys + tools live here; the
// engine itself is generic. cwd paths resolve relative to THIS file.
export default {
  title: '🥒 Pickleague Toolbox',
  // Saved secrets land in tools/toolbox/toolbox.secrets.json (gitignored).
  keys: [
    { name: 'SUPABASE_URL', label: 'Supabase URL', hint: 'https://<ref>.supabase.co (also injected as EXPO_PUBLIC_SUPABASE_URL)',
      aliases: ['supabaseurl', 'expopublicsupabaseurl', 'supaurl', 'projecturl', 'supabase'],
      match: { regex: '^https?://[a-z0-9-]+\\.supabase\\.(co|in)' } },
    { name: 'SUPABASE_SERVICE_ROLE_KEY', label: 'Supabase service-role key', hint: 'bypasses RLS to write — keep secret',
      aliases: ['supabaseservicerolekey', 'servicerole', 'servicerolekey'],
      match: { jwtRole: 'service_role' } },
    { name: 'SUPABASE_ANON_KEY', label: 'Supabase anon key', hint: 'Simulate Flows signs in AS the sim users (exercises RLS + RPC paths); also injected as EXPO_PUBLIC_SUPABASE_ANON_KEY',
      aliases: ['supabaseanonkey', 'expopublicsupabaseanonkey', 'anonkey', 'anon'],
      match: { jwtRole: 'anon' } },
    { name: 'GOOGLE_PLACES_KEY', label: 'Google Places key', hint: 'optional — court location autocomplete parity',
      aliases: ['googleplaceskey', 'expopublicgoogleplaceskey', 'googleapikey', 'google', 'places'],
      match: { regex: '^AIza[\\w-]{20,}$' } },
  ],
  envAliases: {
    SUPABASE_URL: ['EXPO_PUBLIC_SUPABASE_URL'],
    SUPABASE_ANON_KEY: ['EXPO_PUBLIC_SUPABASE_ANON_KEY'],
    GOOGLE_PLACES_KEY: ['EXPO_PUBLIC_GOOGLE_PLACES_KEY'],
  },
  tools: [
    {
      id: 'seed-fake-players', label: 'Seed Fake Players',
      description: 'Create N sim accounts (sim_player_*@pickleague.test, password pickle123), each with a target DUPR and a fully randomized profile — avatar, tagline, tags, name color/styles, frame, availability grid, drilling prefs, paddles, pickles. Always creates a [SIM] league + an active season; all matches are played at the given location and inserted chronologically with standings locked every (days/5) so the SeasonStandings screen shows real per-period history. Match outcomes follow the DUPR gaps so PLUPR converges organically via the real DB triggers; optional calibrate snaps live ratings exactly to target afterward (snapshots keep their organic values). Delete removes all sim players + their matches + the [SIM] league (rating side-effects are reversed by the delete trigger).',
      cwd: '../../scripts', cmd: 'node', baseArgs: ['seed-fake-players.mjs'], needsInstall: true,
      fields: [
        { name: 'count', flag: '--count', type: 'number', default: 12 },
        { name: 'dupr-min', flag: '--dupr-min', type: 'number', default: 3.0, help: 'each player gets a target DUPR uniform in [min,max]' },
        { name: 'dupr-max', flag: '--dupr-max', type: 'number', default: 5.5 },
        { name: 'league', flag: '--league', type: 'text', default: '[SIM] Toolbox League', help: 'created if missing; players join; matches are league matches' },
        { name: 'location', flag: '--location', type: 'text', default: 'Bladium Sports & Fitness Club', help: 'location_name stamped on every match' },
        { name: 'matches', flag: '--matches', type: 'number', default: 60, help: 'total simulated matches across the pool' },
        { name: 'doubles-pct', flag: '--doubles-pct', type: 'number', default: 30, help: '% of matches that are doubles' },
        { name: 'days', flag: '--days', type: 'number', default: 30, help: 'spread played_at over the last N days; season standings refresh every days/5' },
        { name: 'calibrate', flag: '--calibrate', type: 'checkbox', default: true, help: 'after simulating, snap global + league PLUPR exactly to each target DUPR' },
        { name: 'delete', flag: '--delete', type: 'checkbox', help: 'remove all sim players/matches/[SIM] league instead of creating' },
        { name: 'dry-run', flag: '--dry-run', type: 'checkbox', default: true },
      ],
    },
    {
      id: 'simulate-flows', label: 'Simulate Flows',
      description: 'Pick N sim players (from Seed Fake Players) and drive real user flows by SIGNING IN AS THEM (anon key + password) and calling the same tables/RPCs the app does — so RLS policies and RPC grants are exercised for real. Scenarios: league = create league (open/invite) → joins / invite-code redemptions; tournament = create tournament (format / match type / team comp / registration mode) → invites sent + accepted or requests + approvals → doubles pairing → generate round 1 → play matches to completion. Cleanup tears down [SIM]-prefixed leagues/tournaments created by flows.',
      cwd: '../../simulations', cmd: 'npx', baseArgs: ['tsx', 'simulate-flows.ts'], needsInstall: true,
      fields: [
        { name: 'scenario', flag: '--scenario', type: 'select', options: ['tournament', 'league', 'cleanup'], default: 'tournament' },
        { name: 'users', flag: '--users', type: 'number', default: 8, help: 'sim players to involve (MLP: multiple of 4, min 8)' },
        { name: 'match-type', flag: '--match-type', type: 'select', options: ['singles', 'doubles', 'mlp'], default: 'singles', help: 'Team Type — mlp = MLP team tournament (doubles under the hood, teams of 2M+2F)' },
        { name: 'format', flag: '--format', type: 'select', options: ['round_robin', 'single_elimination', 'double_elimination', 'pool_play', 'rotating_partners'], default: 'round_robin', help: 'MLP supports round_robin / pool_play only' },
        { name: 'seeding', flag: '--seeding', type: 'select', options: ['random', 'elo'], default: 'random', help: 'Bracket Seeding — random draw vs PLUPR-based (elo)' },
        { name: 'playoff-format', flag: '--playoff-format', type: 'select', options: ['none', 'top_2', 'top_4', 'top_8'], default: 'none', help: 'round_robin / pool_play (incl. MLP): playoff after group play' },
        { name: 'pool-count', flag: '--pool-count', type: 'number', default: 2, help: 'pool_play only' },
        { name: 'team-creation', flag: '--team-creation', type: 'select', options: ['fixed', 'random'], default: 'fixed', help: 'doubles & MLP (singles ignores it): fixed = players pair/team up via the real RPC flows; random = auto-generated' },
        { name: 'registration-mode', flag: '--registration-mode', type: 'select', options: ['request', 'invite_only'], default: 'request', help: 'request = self-requests + admin approvals; invite_only = invites + accepts' },
        { name: 'league-mode', flag: '--league-mode', type: 'select', options: ['open', 'invite_only'], default: 'open', help: 'league scenario: open = direct joins; invite_only = join requests + invite-code redemption' },
        { name: 'play', flag: '--play', type: 'checkbox', default: true, help: 'tournament: generate the draw and enter scores through completion' },
        { name: 'dry-run', flag: '--dry-run', type: 'checkbox', default: true },
      ],
    },
    {
      id: 'backdate-finish-tournaments', label: 'Backdate & Finish Tournaments',
      description: 'Backdate every open (registration/active) tournament by 30 days, simulate all unfinished matches with realistic scores, then mark it completed. Existing script — no dry-run; writes immediately.',
      cwd: '../../scripts', cmd: 'node', baseArgs: ['backdate-and-finish-tournaments.js'], needsInstall: true,
      fields: [],
    },
  ],
};
