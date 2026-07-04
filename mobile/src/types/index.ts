export type Gender = 'male' | 'female' | 'other' | 'prefer-not-to-say';

export type Profile = {
  id: string;
  username: string;
  full_name: string;
  avatar_url: string | null;
  avatar_id: number;
  tagline: string | null;
  selected_tags: string[];
  badges_public: boolean;
  availability: boolean[];
  total_matches_played: number;
  last_match_at: string | null;
  gender: Gender | null;
  pickles: number;
  welcome_pickles_granted: boolean;
  name_color: string | null;
  // Equipped name-style slugs (FK to shop_items.slug). null = use default rendering.
  list_name_style_id: string | null;
  profile_name_style_id: string | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
  rating: number;
  singles_rating: number;
  doubles_rating: number;
  mixed_doubles_rating: number;
  drilling_enabled: boolean;
  // Recurring weekly template boolean[336] (7 weekdays × 48). Legacy rows may
  // still hold the old date-keyed shape; readers normalize via toWeeklyDrill().
  drill_availability: boolean[] | Record<string, boolean[]>;
  drill_shot_prefs: string[];
  drill_partner_prefs: string[];
  drill_custom_tags: string[];
  created_at: string;
};

export type DrillRequest = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  proposed_slots: { date: string; slot: number }[];
  message: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  accepted_slot: { date: string; slot: number } | null;
  length_minutes: number;
  location_name: string | null;
  location_id: string | null;
  created_at: string;
  responded_at: string | null;
  from_profile?: { id: string; full_name: string; avatar_id: number; avatar_url: string | null; rating: number; name_color?: string | null; list_name_style_id?: string | null };
  to_profile?:   { id: string; full_name: string; avatar_id: number; avatar_url: string | null; rating: number; name_color?: string | null; list_name_style_id?: string | null };
};

export type DrillRequestMessage = {
  id: string;
  request_id: string;
  sender_id: string;
  body: string;
  created_at: string;
};

export type DrillSession = {
  id: string;
  request_id: string | null;
  player1_id: string;
  player2_id: string;
  session_date: string;  // YYYY-MM-DD
  session_slot: number;  // 0..47 (half-hour grid)
  length_minutes: number;
  starts_at: string | null;
  notes: string | null;
  reminder_dismissed_by: string[];
  created_at: string;
};

export type DrillSessionReview = {
  session_id: string;
  user_id: string;
  rating: number | null; // rounded average of the answered facets (back-compat)
  consistency: number | null;
  effort: number | null;
  organization: number | null;
  intentionality: number | null;
  fun: number | null;
  notes: string | null;
  pickles_granted: number;
  created_at: string;
};

export type LocationMatchType = 'singles' | 'doubles_gendered' | 'doubles_mixed';

export type PlayerLocationRating = {
  id: string;
  user_id: string;
  location_name: string;
  match_type: LocationMatchType;
  rating: number;
  wins: number;
  losses: number;
};

export type League = {
  id: string;
  name: string;
  description: string | null;
  created_by: string;
  is_active: boolean;
  is_open: boolean;
  home_court: string | null;
  home_court_lat: number | null;
  home_court_lng: number | null;
  prize_pool: number;
  payout_structure: number[];
  created_at: string;
};

export type LeagueWithStats = League & {
  memberCount: number;
  matchCount: number;
  distinctPlayDays: number;
  myRole: 'admin' | 'co-admin' | 'member' | null; // null = not a member
  hasRequested: boolean;
  // Counts shown on the LeaguesScreen list card to convey activity at a glance.
  activeSeasonCount: number;
  activeTournamentCount: number;
  // Tournaments open for registration (purple) vs. closed-reg but scheduled for
  // a future start (blue). Split out so the card can color them by status.
  openRegistrationTournamentCount: number;
  scheduledTournamentCount: number;
  upcomingEventCount: number;
  openVoteCount: number;
  // League admin (creator backfilled as admin) — for the clickable profile link.
  adminId: string | null;
  adminName: string | null;
  // Baseline PLUPR of the most-recent active season (null when no active season).
  currentBaselinePlupr: number | null;
  // Featured season: active if any (latest), else next upcoming, else null.
  featuredSeasonStatus: 'active' | 'upcoming' | null;
  featuredSeasonStart: string | null;
  featuredSeasonEnd: string | null;
};

export type LeagueJoinRequest = {
  id: string;
  league_id: string;
  user_id: string;
  message: string | null;
  status: 'pending' | 'denied';
  created_at: string;
  profile?: Profile;
};

export type LeagueMember = {
  id: string;
  league_id: string;
  user_id: string;
  role: 'admin' | 'co-admin' | 'member';
  joined_at: string;
  profile?: Profile;
};

export type LeagueInvite = {
  id: string;
  league_id: string;
  created_by: string;
  token: string;
  expires_at: string;
  max_uses: number | null;
  used_count: number;
  is_active: boolean;
  created_at: string;
};

export type LeagueEvent = {
  id: string;
  league_id: string;
  title: string;
  description: string | null;
  created_by: string;
  status: 'voting' | 'scheduled' | 'cancelled';
  vote_ends_at: string;
  confirmed_slot_id: string | null;
  created_at: string;
  slots?: EventSlot[];
};

export type SlotVoter = {
  id: string;
  full_name: string | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
};

export type EventSlot = {
  id: string;
  event_id: string;
  starts_at: string;
  ends_at: string;
  vote_count?: number;
  my_vote?: boolean;
  voters?: SlotVoter[];
};

export type DoublesCategory = 'gendered' | 'mixed' | 'unspecified';

export type ShopCategory =
  | 'avatar'
  | 'cosmetic_badge'
  | 'flair'
  | 'real_world'
  | 'list_name_style'
  | 'profile_name_style';

export type ShopItem = {
  id: string;
  category: ShopCategory;
  slug: string;
  name: string;
  description: string;
  icon: string;
  cost: number;
  payload: Record<string, any>;
  is_active: boolean;
  sort_order: number;
  // When set, item is unlocked by earning the badge (not purchasable).
  // The DB trigger _grant_unlock_items_on_badge auto-grants on badge insert.
  unlock_badge_id?: string | null;
};

export type ShopPurchase = {
  id: string;
  user_id: string;
  shop_item_id: string;
  cost_paid: number;
  purchased_at: string;
};

export type Match = {
  id: string;
  league_id: string;
  match_type: 'singles' | 'doubles';
  doubles_category: DoublesCategory | null; // null for singles
  player1_id: string;
  partner1_id: string | null;
  player2_id: string;
  partner2_id: string | null;
  player1_score: number | null;
  player2_score: number | null;
  winner_id: string | null;
  winner_team: 'team1' | 'team2' | null;
  status: 'pending' | 'scheduled' | 'completed';
  team1_confirmed_by: string | null;
  team2_confirmed_by: string | null;
  confirm_deadline: string | null;
  played_at: string;
  scheduled_at: string | null;
  player1_rating_before: number | null;
  player2_rating_before: number | null;
  player1_rating_after: number | null;
  player2_rating_after: number | null;
  location_name: string | null;
  location_lat: number | null;
  location_lng: number | null;
  is_outdoor: boolean | null;
  was_home_court: boolean | null;
  is_home_court: boolean | null;
  created_at: string;
  player1?: Profile;
  partner1?: Profile;
  player2?: Profile;
  partner2?: Profile;
};

export type Tournament = {
  id: string;
  league_id: string | null;
  name: string;
  description: string | null;
  created_by: string;
  format: 'round_robin' | 'single_elimination' | 'double_elimination' | 'pool_play' | 'mlp' | 'mlp_random' | 'rotating_partners';
  match_type: 'singles' | 'doubles';
  seeding: 'random' | 'elo';
  pool_count: number;
  partner_rotation: 'every_match' | 'every_round' | null;
  registration_mode: 'request' | 'invite_only';
  max_players: number | null;
  status: 'registration' | 'active' | 'completed' | 'cancelled';
  start_time: string | null;
  expected_length_hours: number | null;
  mlp_play_format: 'round_robin' | 'pool_play' | 'round_robin_playoff' | 'pool_play_playoff';
  mlp_pool_count: number;
  mlp_playoff_teams: number;
  // For non-MLP formats (round_robin, pool_play): which playoff bracket runs after group play.
  // MLP keeps mlp_playoff_teams for its own playoff. 'top_2' = Final + 3PM.
  // 'top_1_per_pool' / 'top_2_per_pool' (pool_play only) take N from each pool
  // with crossover seeding; bracket size = pool_count * N.
  playoff_format: 'none' | 'top_2' | 'top_4' | 'top_8' | 'top_1_per_pool' | 'top_2_per_pool';
  // When true AND playoff_format ∈ (top_4, top_8), the advancement trigger
  // creates a third place match between the losing semifinalists once both
  // semifinals complete. (Top 2 always has a 3PM between standings #3/#4.)
  playoff_third_place: boolean;
  // 'fixed' = user-defined pairs/rosters; 'random' = auto-paired/auto-generated.
  // Applies to Doubles and MLP; Singles ignores it.
  team_creation: 'fixed' | 'random';
  location_name: string | null;
  location_lat: number | null;
  location_lng: number | null;
  prize_pool: number;
  pickle_ante: number;
  payout_structure: number[];
  champion_payout_applied_at: string | null;
  created_at: string;
};

export type MlpTeamSlot = 'male_1' | 'male_2' | 'female_1' | 'female_2';

export type MlpTeam = {
  id: string;
  tournament_id: string;
  name: string;
  captain_id: string | null;
  male_1_id: string | null;
  male_2_id: string | null;
  female_1_id: string | null;
  female_2_id: string | null;
  dreambreaker_player_id: string | null;
  status: 'forming' | 'locked';
  seed: number | null;
  is_random_generated: boolean;
  created_at: string;
  // Joined profile fields populated by the screen layer
  captain?:  { id: string; full_name: string } | null;
  male_1?:   { id: string; full_name: string } | null;
  male_2?:   { id: string; full_name: string } | null;
  female_1?: { id: string; full_name: string } | null;
  female_2?: { id: string; full_name: string } | null;
};

export type MlpTeamJoinRequest = {
  id: string;
  team_id: string;
  user_id: string;
  direction: 'invite' | 'request';
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  message: string | null;
  created_at: string;
  responded_at: string | null;
  user_profile?: { id: string; full_name: string } | null;
};

// Doubles partnership for non-MLP doubles tournaments (round-robin /
// single-elim / double-elim / pool-play). Two slots, no gender semantics.
export type DoublesPair = {
  id: string;
  tournament_id: string;
  name: string;
  captain_id: string | null;
  partner_1_id: string | null;
  partner_2_id: string | null;
  status: 'forming' | 'locked';
  seed: number | null;
  is_random_generated: boolean;
  created_at: string;
};

export type DoublesPairJoinRequest = {
  id: string;
  pair_id: string;
  user_id: string;
  direction: 'invite' | 'request';
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  message: string | null;
  responded_at: string | null;
  created_at: string;
};

export type TournamentRegistration = {
  id: string;
  tournament_id: string;
  user_id: string;
  status: 'pending' | 'approved' | 'rejected';
  seed: number | null;
  registered_at: string;
  invited_by: string | null;          // null = user requested in themselves; uuid = admin invite
  role: 'admin' | 'co-admin' | 'member';  // from migration_add_tournament_roles.sql
  profile?: Profile;
};

export type LeagueSeason = {
  id: string;
  league_id: string;
  name: string;
  start_date: string;   // ISO date "YYYY-MM-DD"
  end_date: string;
  total_weeks: number;
  lock_frequency_weeks: number;
  total_periods: number;
  status: 'upcoming' | 'active' | 'completed';
  elo_reset_applied: boolean;
  prize_pool: number;
  payout_structure: number[];
  created_by: string | null;
  created_at: string;
};

export type SeasonSnapshot = {
  id: string;
  season_id: string;
  league_id: string;
  period_number: number;
  snapshot_date: string;
  user_id: string;
  elo_at_snapshot: number;
  rank_at_snapshot: number;
  wins_in_season: number;
  losses_in_season: number;
  profile?: {
    full_name: string;
    avatar_id?: number;
    avatar_url?: string | null;
    name_color?: string | null;
    list_name_style_id?: string | null;
  };
};

export type SeasonFinalStanding = {
  id: string;
  season_id: string;
  league_id: string;
  user_id: string;
  final_rank: number;
  median_rank: number;
  elo_bonus: number;
  new_elo: number;
  profile?: {
    full_name: string;
    avatar_id?: number;
    avatar_url?: string | null;
    name_color?: string | null;
    list_name_style_id?: string | null;
  };
};

export type Wager = {
  id: string;
  user_id: string;
  subject_type:
    | 'match' | 'tournament_match' | 'tournament_rank'
    | 'period_rank' | 'season_rank' | 'match_score' | 'tournament_match_score';
  subject_id: string;
  predicate: Record<string, any>;
  stake: number;
  odds: number;
  potential_payout: number;
  status: 'open' | 'won' | 'lost' | 'cancelled';
  placed_at: string;
  settled_at: string | null;
  notes?: string | null;
  // Enrichment fields populated by `get_my_wagers_with_details` RPC.
  // Absent when the row was fetched via a raw select.
  predicted_user_name?: string | null;
  predicted_rank?: number | null;
  scope_name?: string | null;
  actual_rank?: number | null;
  actual_winner_team?: 'team1' | 'team2' | null;
  actual_team1_score?: number | null;
  actual_team2_score?: number | null;
  team_label_a?: string | null;
  team_label_b?: string | null;
  // When the wagered-on thing is expected to resolve/end, and the league it
  // rolls up to (for context when the subject alone isn't clear).
  expected_end_at?: string | null;
  league_name?: string | null;
};

export type RootStackParamList = {
  Login: undefined;
  Register: undefined;
  GuestJoin: { token: string };
  Home: undefined;
  Play: { initialTab?: 'leagues' | 'tournaments' } | undefined;
  Leagues: { prefillInviteCode?: string } | undefined;
  PlayerProfile: { userId: string; userName: string };
  HeadToHead: { opponentId: string; opponentName: string };
  Tournaments: { leagueId?: string; leagueName?: string };
  CreateTournament: { leagueId?: string };
  TournamentDetail: { tournamentId: string; tournamentName: string };
  TournamentMembers: { tournamentId: string; tournamentName: string };
  TournamentInvitePlayers: { tournamentId: string; tournamentName: string };
  TournamentMatchHistory: { tournamentId: string; title: string };
  TournamentInfo: { tournamentId: string; tournamentName: string };
  Notifications: undefined;
  LeagueDetail: { leagueId: string; leagueName: string };
  LeagueInfo: { leagueId: string; leagueName: string };
  LeagueMembers: { leagueId: string; leagueName: string };
  Invite: { leagueId: string; leagueName: string };
  TournamentInvite: { tournamentId: string; tournamentName: string };
  Events: { leagueId: string; leagueName: string };
  CreateEvent: { leagueId: string };
  EventDetail: { eventId: string; title: string };
  MatchEntry: {
    // Optional: when provided (LeagueDetail "Record Match", tournament/event
    // prefill) the league is fixed and its dropdown is hidden. When omitted
    // (opened from Home via fromHome) the screen shows a required League
    // dropdown + optional Tournament dropdown so the user picks them inline.
    leagueId?: string;
    // Set when launched from the Home "Record a Match" card.
    fromHome?: boolean;
    // When set, recording a scheduled tournament match — the screen updates
    // that tournament_matches row instead of inserting a new league match.
    tournamentId?: string;
    tournamentMatchId?: string;
    tournamentName?: string;
    // When set, the resulting league match is tied to a league_events row
    // (matches.event_id). Surfaces on EventDetail's matches list.
    eventId?: string;
    // Pre-fill the player + match-type fields when arriving from a schedule.
    prefillMatchType?: 'singles' | 'doubles';
    prefillTeam1Player?: string;
    prefillTeam1Partner?: string;
    prefillTeam2Player?: string;
    prefillTeam2Partner?: string;
  };
  MatchHistory: {
    leagueId?: string;
    userId?: string;
    title: string;
    // Pre-applied filters when arriving from a deep link (e.g. tapping a PLUPR
    // facet on Home goes to MatchHistory already filtered to that facet).
    initialMatchType?: 'singles' | 'doubles';
    initialDoublesCategory?: 'gendered' | 'mixed' | 'unspecified';
    // When set, only show matches that this user participated in.
    initialMyMatchesOnly?: boolean;
    // When arriving from a match-confirm notification, scroll to + briefly
    // highlight this match row so the inline Confirm/Reject controls are obvious.
    highlightMatchId?: string;
  };
  CalendarAnalytics: { userId?: string; leagueId?: string; title: string };
  SeasonStandings: { seasonId: string; leagueId: string; leagueName: string };
  Profile: { userId?: string };
  UnlockProgress: undefined;
  Settings: undefined;
  UpgradeAccount: undefined;
  About: undefined;
  Drill: undefined;
  DrillSearch: undefined;
  DrillRequests: undefined;
  Shop: undefined;
  ScoringAlgo: undefined;
  GiftPickles: undefined;
  Godmode: undefined;
  MyWagers: undefined;
  PlayerWagers: {
    userId: string;
    userName?: string;
    scopeType?: 'tournament' | 'league' | 'season';
    scopeId?: string;
    scopeName?: string;
  };
  Bookmarks: undefined;
};
