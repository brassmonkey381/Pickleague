-- User preferences storage.
--
-- Previously prefs lived in AsyncStorage (per-device, lost across reinstalls).
-- Moving to the DB so settings follow a user across devices.
--
-- Schema is a single JSONB blob so new pref keys don't require migrations.
-- Per-user row; RLS lets users read/write only their own row.
--
-- Backfill: insert a default row for every existing profile so the bulk "set
-- everyone's default match type to doubles" requirement is satisfied immediately.

create table if not exists user_preferences (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  prefs       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table user_preferences enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='user_preferences' and policyname='Users see own preferences') then
    create policy "Users see own preferences"
      on user_preferences for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='user_preferences' and policyname='Users insert own preferences') then
    create policy "Users insert own preferences"
      on user_preferences for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='user_preferences' and policyname='Users update own preferences') then
    create policy "Users update own preferences"
      on user_preferences for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

-- Backfill defaults for every existing profile. If the row already exists,
-- merge in defaultMatchType='doubles' to satisfy the bulk requirement.
insert into user_preferences (user_id, prefs)
select id, jsonb_build_object(
  'defaultMatchType',       'doubles',
  'defaultScoreLimit',      11,
  'notifyMatchResults',     true,
  'notifyEventReminders',   true,
  'notifyLeagueUpdates',    true,
  'notifyTournamentUpdates',true,
  'notifyChallenges',       true
)
from profiles
on conflict (user_id) do update
  set prefs = user_preferences.prefs || jsonb_build_object('defaultMatchType','doubles'),
      updated_at = now();
