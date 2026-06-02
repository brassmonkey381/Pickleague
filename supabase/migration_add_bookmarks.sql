-- Bookmarks: lets users save any of (tournament, league, event, drill_session, profile)
-- to a personal list. Surfaced on the Bookmarks page and via a 🔖 icon on Home.
--
-- target_type is a free string + check constraint so adding new bookmarkable
-- kinds later only requires loosening the check; target_id is intentionally a
-- plain uuid (no FK) since the referenced row's table varies by type. Stale
-- bookmarks (target deleted) are filtered out client-side when listing.

create table if not exists public.bookmarks (
  user_id     uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('tournament','league','event','drill_session','profile')),
  target_id   uuid not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, target_type, target_id)
);

create index if not exists idx_bookmarks_user_created on public.bookmarks(user_id, created_at desc);

alter table public.bookmarks enable row level security;

drop policy if exists bookmarks_select_own on public.bookmarks;
create policy bookmarks_select_own on public.bookmarks
  for select using (auth.uid() = user_id);

drop policy if exists bookmarks_insert_own on public.bookmarks;
create policy bookmarks_insert_own on public.bookmarks
  for insert with check (auth.uid() = user_id);

drop policy if exists bookmarks_delete_own on public.bookmarks;
create policy bookmarks_delete_own on public.bookmarks
  for delete using (auth.uid() = user_id);

notify pgrst, 'reload schema';
