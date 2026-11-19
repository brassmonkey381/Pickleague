-- migration_court_pass_xp_tournament_match.sql — PKL-047: tournament match pay earns Court Pass XP.
--
-- PKL-042 (migration_tournament_rewards.sql) pays every tournament match the
-- normal match curve through _grant_tournament_match_bonus, inside the daily
-- play cap. That source was not in the Court Pass allowlist, so tournament
-- play earned pickles and no pickleballs. It joins the allowlist at the same
-- 0.5 as league match pay (_grant_match_game_bonus).
-- Placement pay (_grant_tournament_placement_pay) stays out: it is outside
-- the play cap, like prizes.
-- Safe to re-run.

insert into public.reward_track_xp_sources (source, xp_ratio, note) values
  ('_grant_tournament_match_bonus', 0.5, 'a tournament match: the match curve, inside the daily cap (migration_tournament_rewards.sql §4)')
on conflict (source) do update set xp_ratio = excluded.xp_ratio, note = excluded.note;
