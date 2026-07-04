-- New-tournament announcements now also reach users who BOOKMARKED the league.
-- Builds on migration_notification_generators.sql (members-only audience) and
-- the generic bookmarks table (target_type='league').
--
-- Audience = league members ∪ league bookmarkers, deduped (a bookmarking member
-- gets one notification, with the member copy), creator always excluded.
-- Idempotent: create or replace only.

create or replace function public.notify_new_tournament()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  if new.league_id is null then
    return new;  -- standalone tournament, no league audience
  end if;

  for r in
    select u.user_id, bool_or(u.is_member) as is_member
    from (
      select lm.user_id, true as is_member
      from public.league_members lm
      where lm.league_id = new.league_id
      union all
      select b.user_id, false
      from public.bookmarks b
      where b.target_type = 'league' and b.target_id = new.league_id
    ) u
    where new.created_by is null or u.user_id <> new.created_by
    group by u.user_id
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category)
    values (
      r.user_id,
      '🏆 New tournament: ' || new.name,
      case when r.is_member
        then 'A new tournament just opened in your league. Tap to register.'
        else 'A new tournament just opened in a league you bookmarked. Tap to check it out.'
      end,
      'tournament', new.id, 'tournament', 'notifyTournamentUpdates'
    );
  end loop;
  return new;
exception when others then
  -- Never let a notification failure roll back the tournament creation.
  return new;
end $$;
