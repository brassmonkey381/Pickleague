-- ============================================================
-- One-off repair: profiles.total_matches_played and last_match_at from
-- confirmed (status 'completed') league matches, counting every player on
-- the match (player1/2, partner1/2).
--
-- Run ONCE, after migration_match_count_fix.sql (before it, every new
-- insert keeps adding to the totals). Idempotent: a second run changes
-- nothing. Not a migration (no migration_ prefix): a data fix.
--   supabase db query --linked -f supabase/repair_match_counts.sql -o csv
-- Returns one row: how many profiles changed.
--
-- Preview first (read-only; the same numbers, nothing written):
--
--   with played as (
--     select u.id, count(*) as n, max(m.played_at) as last_at
--       from public.matches m
--       cross join lateral (values (m.player1_id), (m.partner1_id), (m.player2_id), (m.partner2_id)) as u(id)
--      where m.status = 'completed' and u.id is not null
--      group by u.id
--   )
--   select p.id, p.full_name,
--          p.total_matches_played as stored, coalesce(pl.n, 0) as confirmed,
--          p.last_match_at as stored_last, pl.last_at as confirmed_last
--     from public.profiles p
--     left join played pl on pl.id = p.id
--    where p.total_matches_played is distinct from coalesce(pl.n, 0)
--       or p.last_match_at is distinct from pl.last_at
--    order by abs(coalesce(p.total_matches_played, 0) - coalesce(pl.n, 0)) desc;
--
-- NB: recompute_all_plupr() sets total_matches_played its own way (it adds
-- completed tournament matches and skips unspecified-category doubles), so a
-- later run of it gives different totals than this file.
-- ============================================================

with played as (
  select u.id, count(*) as n, max(m.played_at) as last_at
    from public.matches m
    cross join lateral (values (m.player1_id), (m.partner1_id), (m.player2_id), (m.partner2_id)) as u(id)
   where m.status = 'completed' and u.id is not null
   group by u.id
),
changed as (
  update public.profiles p
     set total_matches_played = coalesce(pl.n, 0),
         last_match_at        = pl.last_at
    from public.profiles p2
    left join played pl on pl.id = p2.id
   where p2.id = p.id
     and (p.total_matches_played is distinct from coalesce(pl.n, 0)
          or p.last_match_at is distinct from pl.last_at)
  returning p.id
)
select count(*) as profiles_changed from changed;
