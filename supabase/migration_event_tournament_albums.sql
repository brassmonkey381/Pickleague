-- ============================================================
-- Photo albums on events and tournaments.
--
-- Everyone in an event or tournament can add photos to its shared album and
-- see everyone else's; nobody else can (not even when the event or tournament
-- itself is public). Kept private on purpose: these are photos of people.
--
--   * Who's in it (_pl_album_member):
--       event       a current member of the event's league, or its creator
--       tournament  an approved player, or a tournament admin (creator, or a
--                   league admin / co-admin of its league)
--     plus the moderator (is_godmode_user).
--   * Who runs it (_pl_album_manager): the event's creator or a league admin /
--     co-admin; a tournament admin; the moderator. They can remove anyone's
--     photo. Everyone can remove their own.
--   * Blocks hide photos both ways (blocked_between), in the table and in
--     storage, so a blocked player's photo can't even be fetched.
--   * 4 photos per person per album (album.full); no cap on the album.
--
-- Files live in the private `album-photos` bucket at
--   <kind>/<event or tournament id>/<uploader id>/<photo id>.<ext>
-- and the app reads them through short-lived signed URLs. A row in
-- album_photos is the photo; the app adds the row first (the caps and the
-- membership check happen there), then uploads the file to the row's path.
--
-- Removing: the app deletes the row, then the file through the Storage API
-- (storage.objects can't be deleted from SQL). An event or tournament that is
-- deleted takes its rows with it; its files stay in the bucket, unreachable.
--
-- Reports: content_reports gains the 'photo' subject (subject_id = the photo's
-- row id; the snapshot carries its path).
--
-- Re-runnable.
-- ============================================================

-- 1. The photos -----------------------------------------------------------
create table if not exists public.album_photos (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid references public.league_events(id) on delete cascade,
  tournament_id uuid references public.tournaments(id) on delete cascade,
  uploader_id   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  path          text not null unique,
  width         integer check (width is null or width > 0),
  height        integer check (height is null or height > 0),
  created_at    timestamptz not null default now(),
  constraint album_photos_one_album check (num_nonnulls(event_id, tournament_id) = 1)
);

comment on table public.album_photos is
  'Event and tournament photo albums. One row per photo; the file is in the '
  'album-photos bucket at path. See migration_event_tournament_albums.sql.';

create index if not exists album_photos_event_idx on public.album_photos (event_id, created_at) where event_id is not null;
create index if not exists album_photos_tournament_idx on public.album_photos (tournament_id, created_at) where tournament_id is not null;
create index if not exists album_photos_uploader_idx on public.album_photos (uploader_id);

alter table public.album_photos enable row level security;

-- 2. Who's in an album, who runs it ---------------------------------------
-- p_kind is 'event' or 'tournament'; p_id is text so the storage policies can
-- pass a path segment straight in (anything that isn't a uuid is simply no).
-- SECURITY DEFINER because they read league_members / tournament_registrations
-- rows the caller's own policies may hide; they answer only for auth.uid().
-- Called from RLS policies, so authenticated keeps EXECUTE.
create or replace function public._pl_album_member(p_kind text, p_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null or p_id is null
     or p_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_id := p_id::uuid;
  if public.is_godmode_user(v_uid) then
    return exists (select 1 from public.league_events where id = v_id and p_kind = 'event')
        or exists (select 1 from public.tournaments where id = v_id and p_kind = 'tournament');
  end if;
  if p_kind = 'event' then
    return exists (
      select 1 from public.league_events e
       where e.id = v_id
         and (e.created_by = v_uid
              or exists (select 1 from public.league_members m
                          where m.league_id = e.league_id and m.user_id = v_uid
                            and (m.expires_at is null or m.expires_at > now())))
    );
  elsif p_kind = 'tournament' then
    return exists (
      select 1 from public.tournaments t
       where t.id = v_id
         and (t.created_by = v_uid
              or exists (select 1 from public.tournament_registrations r
                          where r.tournament_id = t.id and r.user_id = v_uid and r.status = 'approved')
              or (t.league_id is not null and exists (
                    select 1 from public.league_members m
                     where m.league_id = t.league_id and m.user_id = v_uid
                       and m.role in ('admin', 'co-admin'))))
    );
  end if;
  return false;
end $$;

create or replace function public._pl_album_manager(p_kind text, p_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null or p_id is null
     or p_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if public.is_godmode_user(v_uid) then return true; end if;
  v_id := p_id::uuid;
  if p_kind = 'event' then
    return exists (
      select 1 from public.league_events e
       where e.id = v_id
         and (e.created_by = v_uid
              or exists (select 1 from public.league_members m
                          where m.league_id = e.league_id and m.user_id = v_uid
                            and m.role in ('admin', 'co-admin')))
    );
  elsif p_kind = 'tournament' then
    return exists (
      select 1 from public.tournaments t
       where t.id = v_id
         and (t.created_by = v_uid
              or (t.league_id is not null and exists (
                    select 1 from public.league_members m
                     where m.league_id = t.league_id and m.user_id = v_uid
                       and m.role in ('admin', 'co-admin'))))
    );
  end if;
  return false;
end $$;

revoke all on function public._pl_album_member(text, text) from public, anon;
revoke all on function public._pl_album_manager(text, text) from public, anon;
grant execute on function public._pl_album_member(text, text) to authenticated, service_role;
grant execute on function public._pl_album_manager(text, text) to authenticated, service_role;

-- 3. Row policies -----------------------------------------------------------
drop policy if exists "Album members see album photos"   on public.album_photos;
drop policy if exists "Album members add their photos"   on public.album_photos;
drop policy if exists "Uploaders and organizers remove album photos" on public.album_photos;

create policy "Album members see album photos" on public.album_photos
  for select to authenticated using (
    public._pl_album_member(
      case when album_photos.event_id is not null then 'event' else 'tournament' end,
      coalesce(album_photos.event_id, album_photos.tournament_id)::text)
    and not public.blocked_between(auth.uid(), album_photos.uploader_id)
  );

-- The path must be this album's folder and the uploader's own subfolder.
create policy "Album members add their photos" on public.album_photos
  for insert to authenticated with check (
    album_photos.uploader_id = auth.uid()
    and public._pl_album_member(
      case when album_photos.event_id is not null then 'event' else 'tournament' end,
      coalesce(album_photos.event_id, album_photos.tournament_id)::text)
    and album_photos.path like
      (case when album_photos.event_id is not null then 'event' else 'tournament' end)
      || '/' || coalesce(album_photos.event_id, album_photos.tournament_id)::text
      || '/' || auth.uid()::text || '/%'
  );

create policy "Uploaders and organizers remove album photos" on public.album_photos
  for delete to authenticated using (
    album_photos.uploader_id = auth.uid()
    or public._pl_album_manager(
      case when album_photos.event_id is not null then 'event' else 'tournament' end,
      coalesce(album_photos.event_id, album_photos.tournament_id)::text)
  );
-- No UPDATE policy: a photo is added or removed, never changed.

grant select, insert, delete on public.album_photos to authenticated;
revoke all on public.album_photos from anon;

-- 4. The caps ----------------------------------------------------------------
-- The count reads every row of the album (some hidden from the uploader by
-- blocks), so it runs as the owner. Neither function is callable directly.
create or replace function public._pl_album_photo_count(p_event uuid, p_tournament uuid, p_uploader uuid)
returns table (mine integer, total integer)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) filter (where a.uploader_id = p_uploader)::int,
         count(*)::int
    from public.album_photos a
   where (p_event is not null and a.event_id = p_event)
      or (p_tournament is not null and a.tournament_id = p_tournament);
$$;
revoke all on function public._pl_album_photo_count(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public._pl_album_photos_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mine  integer;
  v_total integer;
begin
  -- One album at a time per uploader, so two quick batches can't both slip in.
  perform pg_advisory_xact_lock(hashtextextended(
    coalesce(new.event_id, new.tournament_id)::text || ':' || new.uploader_id::text, 0));
  select c.mine, c.total into v_mine, v_total
    from public._pl_album_photo_count(new.event_id, new.tournament_id, new.uploader_id) c;
  if v_mine >= 4 then
    raise exception 'You can add up to 4 photos to this album.'
      using hint = 'pl:album.full', errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public._pl_album_photos_cap() from public, anon, authenticated;

drop trigger if exists album_photos_cap on public.album_photos;
create trigger album_photos_cap
  before insert on public.album_photos
  for each row execute function public._pl_album_photos_cap();

-- 5. What the album screen needs to know ------------------------------------
-- Can I add, can I remove anyone's, how many have I added. Never errors: an
-- album you're not in answers can_view = false.
create or replace function public.album_access(p_kind text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_member boolean;
  v_mine   integer := 0;
begin
  if v_uid is null then
    return jsonb_build_object('can_view', false, 'can_add', false, 'can_manage', false, 'mine', 0, 'cap', 4);
  end if;
  v_member := public._pl_album_member(p_kind, p_id::text);
  if v_member then
    select c.mine into v_mine
      from public._pl_album_photo_count(
             case when p_kind = 'event' then p_id end,
             case when p_kind = 'tournament' then p_id end,
             v_uid) c;
  end if;
  return jsonb_build_object(
    'can_view',   v_member,
    'can_add',    v_member,
    'can_manage', v_member and public._pl_album_manager(p_kind, p_id::text),
    'mine',       coalesce(v_mine, 0),
    'cap',        4);
end $$;
revoke all on function public.album_access(text, uuid) from public, anon;
grant execute on function public.album_access(text, uuid) to authenticated, service_role;

-- 6. The bucket ---------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'album-photos', 'album-photos', false,
  10 * 1024 * 1024,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Path segments: [1] kind, [2] event or tournament id, [3] uploader id.
drop policy if exists "Album members read album files"      on storage.objects;
drop policy if exists "Album members upload their files"    on storage.objects;
drop policy if exists "Uploaders and organizers remove album files" on storage.objects;

create policy "Album members read album files" on storage.objects
  for select to authenticated using (
    bucket_id = 'album-photos'
    and public._pl_album_member((storage.foldername(name))[1], (storage.foldername(name))[2])
    and (storage.foldername(name))[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and not public.blocked_between(auth.uid(), ((storage.foldername(name))[3])::uuid)
  );

-- Only into your own folder of an album you're in, and only for a photo row
-- you've already added (so the caps hold for the files too).
create policy "Album members upload their files" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'album-photos'
    and (storage.foldername(name))[3] = auth.uid()::text
    and public._pl_album_member((storage.foldername(name))[1], (storage.foldername(name))[2])
    and exists (select 1 from public.album_photos a
                 where a.path = storage.objects.name and a.uploader_id = auth.uid())
  );

create policy "Uploaders and organizers remove album files" on storage.objects
  for delete to authenticated using (
    bucket_id = 'album-photos'
    and ((storage.foldername(name))[3] = auth.uid()::text
         or public._pl_album_manager((storage.foldername(name))[1], (storage.foldername(name))[2]))
  );

-- 7. Reports can be about a photo -------------------------------------------
alter table public.content_reports drop constraint if exists content_reports_subject_type_check;
alter table public.content_reports add constraint content_reports_subject_type_check
  check (subject_type in ('profile', 'avatar', 'message', 'league', 'event', 'tournament', 'photo', 'other'));
