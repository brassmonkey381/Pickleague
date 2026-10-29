-- ============================================================
-- Seen prompts (2026-10-29, PKL-013): one row per account per explainer
-- prompt it has seen, so a one-time guide (the Instagram Story link guide
-- before the first finish-card share, key 'share_link_sticker_guide') shows
-- once per ACCOUNT, across devices and reinstalls. Same shape as Doggle's.
--
-- Each player reads, adds and clears only their own rows (RLS). No RPCs, so
-- migration_rls_hardening_2026q3.sql needs no change.
--
-- Re-runnable.
-- ============================================================

create table if not exists public.user_seen_prompts (
  user_id uuid not null references auth.users (id) on delete cascade,
  key     text not null check (length(key) between 1 and 100),
  seen_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.user_seen_prompts enable row level security;

revoke all on public.user_seen_prompts from anon, authenticated;
grant select, insert, delete on public.user_seen_prompts to authenticated;

drop policy if exists "Own seen prompts readable" on public.user_seen_prompts;
create policy "Own seen prompts readable" on public.user_seen_prompts
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Own seen prompts insertable" on public.user_seen_prompts;
create policy "Own seen prompts insertable" on public.user_seen_prompts
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "Own seen prompts deletable" on public.user_seen_prompts;
create policy "Own seen prompts deletable" on public.user_seen_prompts
  for delete to authenticated using ((select auth.uid()) = user_id);
