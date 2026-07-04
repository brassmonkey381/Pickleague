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
      // Fields mirror the app's CreateTournament screen and show/hide the SAME
      // way: Playoff Format only appears for round_robin / pool_play (never for
      // single/double elim or rotating partners), and its option set differs by
      // format (round_robin & MLP → top_2/4/8; non-MLP pool_play → per-pool).
      // Team Creation only for doubles & MLP; pool count only for pool_play.
      fields: [
        { name: 'scenario', flag: '--scenario', type: 'select', options: ['tournament', 'league', 'cleanup'], default: 'tournament' },
        { name: 'users', flag: '--users', type: 'number', default: 8, help: 'sim players to involve (MLP: multiple of 4, min 8)' },
        // Team Type
        { name: 'match-type', flag: '--match-type', type: 'select', options: ['singles', 'doubles', 'mlp'], default: 'singles', help: 'Team Type — mlp = MLP team tournament (doubles under the hood, teams of 2M+2F)', showIf: { scenario: ['tournament'] } },
        // Format — the app shows all 5 cards to every Team Type. Two app rules
        // mirrored here: singles can't pick rotating_partners (the app flips it
        // to doubles), and MLP coerces non-RR/pool formats to round-robin play
        // at insert (same as the app's payload mapping).
        { name: 'format', flag: '--format', type: 'select', default: 'round_robin', showIf: { scenario: ['tournament'] },
          help: 'MLP: single/double elim + rotating coerce to round-robin play (same as the app)',
          options: { __by: 'match-type', default: ['round_robin', 'single_elimination', 'double_elimination', 'pool_play'], map: {
            singles: ['round_robin', 'single_elimination', 'double_elimination', 'pool_play'],
            doubles: ['round_robin', 'single_elimination', 'double_elimination', 'pool_play', 'rotating_partners'],
            mlp:     ['round_robin', 'single_elimination', 'double_elimination', 'pool_play', 'rotating_partners'],
          } } },
        // Bracket Seeding
        { name: 'seeding', flag: '--seeding', type: 'select', options: ['random', 'elo'], default: 'random', help: 'Bracket Seeding — random draw vs PLUPR-based (elo)', showIf: { scenario: ['tournament'] } },
        // Playoff Format — round_robin / pool_play only. Base options are always
        // None/Top 2/Top 4/Top 8; non-MLP pool_play ADDS the per-pool pair.
        { name: 'playoff-format', flag: '--playoff-format', type: 'select', default: 'none',
          help: 'playoff after group play',
          showIf: { scenario: ['tournament'], format: ['round_robin', 'pool_play'] },
          options: { __by: ['match-type', 'format'], default: ['none', 'top_2', 'top_4', 'top_8'], map: {
            'singles|pool_play': ['none', 'top_2', 'top_4', 'top_8', 'top_1_per_pool', 'top_2_per_pool'],
            'doubles|pool_play': ['none', 'top_2', 'top_4', 'top_8', 'top_1_per_pool', 'top_2_per_pool'],
          } } },
        // Third Place Match — top_4 / top_8 playoffs only (same toggle as the app)
        { name: 'third-place', flag: '--third-place', type: 'checkbox', help: 'losing semifinalists play a 3rd-place match',
          showIf: { scenario: ['tournament'], format: ['round_robin', 'pool_play'], 'playoff-format': ['top_4', 'top_8'] } },
        // Pool count — pool_play only; the app offers 2/3/4/6 (MLP caps at 4)
        { name: 'pool-count', flag: '--pool-count', type: 'select', default: '2', help: 'number of pools',
          showIf: { scenario: ['tournament'], format: ['pool_play'] },
          options: { __by: 'match-type', default: ['2', '3', '4', '6'], map: { mlp: ['2', '3', '4'] } } },
        // Team Creation — doubles & MLP only (singles has no teams)
        { name: 'team-creation', flag: '--team-creation', type: 'select', options: ['fixed', 'random'], default: 'fixed', help: 'fixed = players pair/team up via the real RPC flows; random = auto-generated', showIf: { scenario: ['tournament'], 'match-type': ['doubles', 'mlp'] } },
        { name: 'registration-mode', flag: '--registration-mode', type: 'select', options: ['request', 'invite_only'], default: 'request', help: 'request = self-requests + admin approvals; invite_only = invites + accepts', showIf: { scenario: ['tournament'] } },
        { name: 'league-mode', flag: '--league-mode', type: 'select', options: ['open', 'invite_only'], default: 'open', help: 'league scenario: open = direct joins; invite_only = join requests + invite-code redemption', showIf: { scenario: ['league'] } },
        { name: 'auto-rounds', flag: '--auto-rounds', type: 'checkbox', default: true, help: 'run the WHOLE tournament round-by-round to completion — playoffs generated, every step invariant-checked, failures drafted into simulations/reports/<name>.md', showIf: { scenario: ['tournament'] } },
        { name: 'economy', flag: '--economy', type: 'checkbox', default: true, help: 'random ante into the pot, random payout structure, random tournament_rank wagers — then verify pot size, payout dispatch + notifications, wager settlement vs actual final ranks, and the champion badge', showIf: { scenario: ['tournament'] } },
        { name: 'play', flag: '--play', type: 'checkbox', default: false, help: 'lighter alternative: only score the generated first batch (ignored when auto-rounds is on)', showIf: { scenario: ['tournament'] } },
        { name: 'dry-run', flag: '--dry-run', type: 'checkbox', default: true },
      ],
    },
    {
      id: 'migrations', label: 'Migrations (check / run)',
      description: 'check = diff every function defined in supabase/migration_*.sql against LIVE prod (canonical = the file most recently touched in git; schema.sql/setup_all_migrations.sql excluded) and report OK / DRIFT / MISSING — this is how we caught prod running a weeks-old create_mlp_team. run = apply one migration file to prod via the service-role admin helper; dry-run prints the SQL without executing. Function bodies only — tables/triggers/policies are out of scope.',
      cwd: '../../scripts', cmd: 'node', baseArgs: ['migration-audit.mjs'], needsInstall: true,
      fields: [
        { name: 'mode', flag: '--mode', type: 'select', options: ['check', 'run'], default: 'check' },
        { name: 'only', flag: '--only', type: 'text', placeholder: 'mlp', help: 'check mode: only audit files whose name contains this' },
        { name: 'file', flag: '--file', type: 'text', placeholder: 'migration_x.sql', help: 'run mode: which supabase/ file to apply' },
        { name: 'dry-run', flag: '--dry-run', type: 'checkbox', default: true, help: 'run mode: print the SQL, do not execute' },
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
