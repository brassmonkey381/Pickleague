export type Profile = {
  id: string;
  username: string;
  full_name: string;
  avatar_url: string | null;
  rating: number;
  singles_rating: number;
  doubles_rating: number;
  created_at: string;
};

export type PlayerLocationRating = {
  id: string;
  user_id: string;
  location_name: string;
  match_type: 'singles' | 'doubles';
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

export type Match = {
  id: string;
  league_id: string;
  match_type: 'singles' | 'doubles';
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
  format: 'round_robin' | 'single_elimination' | 'double_elimination' | 'pool_play' | 'mlp' | 'rotating_partners';
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
  created_at: string;
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
  LeagueDetail: { leagueId: string; leagueName: string };
  LeagueMembers: { leagueId: string; leagueName: string };
  Invite: { leagueId: string; leagueName: string };
  Events: { leagueId: string; leagueName: string };
  CreateEvent: { leagueId: string };
  EventDetail: { eventId: string; title: string };
  MatchEntry: { leagueId: string };
  MatchHistory: { leagueId?: string; userId?: string; title: string };
  CalendarAnalytics: { userId?: string; leagueId?: string; title: string };
  Standings: { leagueId: string };
  Profile: { userId?: string };
};
