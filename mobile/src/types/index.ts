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
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
  rating: number;
  singles_rating: number;
  doubles_rating: number;
  mixed_doubles_rating: number;
  drilling_enabled: boolean;
  drill_availability: Record<string, boolean[]>;
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
  created_at: string;
  responded_at: string | null;
  from_profile?: { id: string; full_name: string; avatar_id: number; avatar_url: string | null; rating: number };
  to_profile?:   { id: string; full_name: string; avatar_id: number; avatar_url: string | null; rating: number };
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

export type EventSlot = {
  id: string;
  event_id: string;
  starts_at: string;
  ends_at: string;
  vote_count?: number;
  my_vote?: boolean;
};

export type DoublesCategory = 'gendered' | 'mixed' | 'unspecified';

export type ShopCategory = 'avatar' | 'cosmetic_badge' | 'flair';

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
  status: 'completed';
  played_at: string;
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
  location_name: string | null;
  location_lat: number | null;
  location_lng: number | null;
  prize_pool: number;
  pickle_ante: number;
  payout_structure: number[];
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

export type TournamentRegistration = {
  id: string;
  tournament_id: string;
  user_id: string;
  status: 'pending' | 'approved' | 'rejected';
  seed: number | null;
  registered_at: string;
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
  profile?: { full_name: string; avatar_id?: number; avatar_url?: string | null };
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
  profile?: { full_name: string; avatar_id?: number; avatar_url?: string | null };
};

export type RootStackParamList = {
  Login: undefined;
  Register: undefined;
  Home: undefined;
  Leagues: undefined;
  PlayerProfile: { userId: string; userName: string };
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
  Events: { leagueId: string; leagueName: string };
  CreateEvent: { leagueId: string };
  EventDetail: { eventId: string; title: string };
  MatchEntry: { leagueId: string };
  MatchHistory: { leagueId?: string; userId?: string; title: string };
  CalendarAnalytics: { userId?: string; leagueId?: string; title: string };
  SeasonStandings: { seasonId: string; leagueId: string; leagueName: string };
  Profile: { userId?: string };
  Settings: undefined;
  About: undefined;
  Drill: undefined;
  DrillSearch: undefined;
  DrillRequests: undefined;
  Shop: undefined;
  ScoringAlgo: undefined;
  GiftPickles: undefined;
};
