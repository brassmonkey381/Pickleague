-- ============================================================
-- User-submitted venues — mirrors Doggle's dog-place submission flow
-- (db/migrations/0056 + 0058), adapted to public.venues, is_godmode_user(),
-- and sports (drops dog-specific leash/fenced/amenities + the Google-mapping
-- coupling). Model:
--   * a submission is a venues row with confirmation_status = 'unconfirmed',
--     source = 'user', submitted via created_by;
--   * duplicate submissions of the same spot cluster via affirmations (a user
--     agrees an existing unconfirmed submission is the same place) — client-
--     mediated (find_nearby_venue_submissions), never auto;
--   * confirmation is godmode-admin only (no auto-threshold);
--   * unconfirmed venues appear in search immediately (ranked below confirmed);
--     'rejected' venues are hidden.
--
-- Supersedes the interim suggest_venue() from migration_add_venue_suggestions.sql
-- (resolve_venue() is kept as a general dedup helper for future imports).
-- Requires: migration_add_venues.sql, migration_add_venue_suggestions.sql,
--           is_godmode_user() (migration_add_godmode_delete.sql).
-- Apply:  supabase db query --linked -f supabase/migration_add_venue_submissions.sql
-- ============================================================

-- 1. confirmation_status gains 'rejected'; add submission_cluster_id.
alter table public.venues drop constraint if exists venues_confirmation_status_check;
alter table public.venues
  add constraint venues_confirmation_status_check
  check (confirmation_status in ('confirmed', 'unconfirmed', 'rejected'));

alter table public.venues
  add column if not exists submission_cluster_id uuid;

create index if not exists venues_confirmation_status_idx on public.venues (confirmation_status);
create index if not exists venues_submission_cluster_idx
  on public.venues (submission_cluster_id) where submission_cluster_id is not null;

-- 2. Affirmations: a different user agrees an unconfirmed submission is the same place.
create table if not exists public.venue_submission_affirmations (
  id                uuid primary key default gen_random_uuid(),
  cluster_id        uuid not null,
  affirmed_venue_id text not null references public.venues (id) on delete cascade,
  profile_id        uuid not null references public.profiles (id) on delete cascade,
  lat               double precision,
  lng               double precision,
  created_at        timestamptz not null default now(),
  unique (profile_id, affirmed_venue_id)
);
create index if not exists venue_submission_affirmations_cluster_idx
  on public.venue_submission_affirmations (cluster_id);

alter table public.venue_submission_affirmations enable row level security;
drop policy if exists venue_submission_affirmations_select on public.venue_submission_affirmations;
create policy venue_submission_affirmations_select on public.venue_submission_affirmations
  for select to authenticated using (true);

-- 3. The interim suggest_venue() is superseded by submit_venue() below.
drop function if exists public.suggest_venue(text, double precision, double precision, text[], text, text, text, boolean);

-- 4. Nearby unconfirmed submissions (for the "same place?" prompt before submitting).
create or replace function public.find_nearby_venue_submissions(
  p_lat double precision, p_lng double precision, p_radius_m double precision default 100
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if p_lat is null or p_lng is null then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.distance_meters), '[]'::jsonb)
  into v_result
  from (
    select vn.id, vn.name, vn.kind, vn.sport, vn.address, vn.city, vn.lat, vn.lng,
      vn.submission_cluster_id, vn.confirmation_status,
      round(public.haversine_meters(p_lat, p_lng, vn.lat, vn.lng)::numeric, 1) as distance_meters
    from public.venues vn
    where vn.confirmation_status = 'unconfirmed'
      and public.haversine_meters(p_lat, p_lng, vn.lat, vn.lng) <= p_radius_m
    order by public.haversine_meters(p_lat, p_lng, vn.lat, vn.lng)
    limit 5
  ) t;
  return v_result;
end;
$$;
revoke all on function public.find_nearby_venue_submissions(double precision, double precision, double precision) from public;
grant execute on function public.find_nearby_venue_submissions(double precision, double precision, double precision) to authenticated;

-- 5. Submit a new unconfirmed venue OR affirm an existing nearby submission.
create or replace function public.submit_venue(
  p_name text,
  p_lat double precision,
  p_lng double precision,
  p_sports text[] default '{}',
  p_kind text default 'court',
  p_address text default null,
  p_city text default null,
  p_affirm_venue_id text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_id text;
  v_cluster uuid;
  v_existing_cluster uuid;
begin
  if v_me is null then raise exception 'Not signed in'; end if;
  if p_lat is null or p_lng is null then raise exception 'Location required'; end if;

  -- Affirm branch: agree an existing unconfirmed submission is the same place.
  if p_affirm_venue_id is not null and trim(p_affirm_venue_id) <> '' then
    select vn.submission_cluster_id into v_existing_cluster
    from public.venues vn
    where vn.id = p_affirm_venue_id and vn.confirmation_status = 'unconfirmed';
    if not found then raise exception 'Submission not found'; end if;

    v_cluster := coalesce(v_existing_cluster, gen_random_uuid());
    if v_existing_cluster is null then
      update public.venues set submission_cluster_id = v_cluster where id = p_affirm_venue_id;
    end if;

    insert into public.venue_submission_affirmations (cluster_id, affirmed_venue_id, profile_id, lat, lng)
    values (v_cluster, p_affirm_venue_id, v_me, p_lat, p_lng)
    on conflict (profile_id, affirmed_venue_id) do update set lat = excluded.lat, lng = excluded.lng;

    return jsonb_build_object('venue_id', p_affirm_venue_id, 'affirmed', true, 'cluster_id', v_cluster);
  end if;

  -- New submission branch.
  if trim(coalesce(p_name, '')) = '' then raise exception 'Name is required'; end if;

  v_cluster := gen_random_uuid();
  v_id := 'user:' || replace(v_cluster::text, '-', '');
  insert into public.venues (
    id, sport, name, kind, lat, lng, address, city, source, confirmation_status,
    created_by, submission_cluster_id
  ) values (
    v_id, coalesce(p_sports, '{}'), trim(p_name), coalesce(nullif(trim(p_kind), ''), 'court'),
    p_lat, p_lng, nullif(trim(coalesce(p_address, '')), ''), nullif(trim(coalesce(p_city, '')), ''),
    'user', 'unconfirmed', v_me, v_cluster
  );

  return jsonb_build_object('venue_id', v_id, 'affirmed', false, 'cluster_id', v_cluster);
end;
$$;
revoke all on function public.submit_venue(text, double precision, double precision, text[], text, text, text, text) from public;
grant execute on function public.submit_venue(text, double precision, double precision, text[], text, text, text, text) to authenticated;

-- 6. Admin (godmode) review queue.
create or replace function public.list_admin_venue_reviews()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if not public.is_godmode_user() then raise exception 'Admin access required'; end if;
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc), '[]'::jsonb)
  into v_result
  from (
    select vn.id, vn.name, vn.sport, vn.kind, vn.lat, vn.lng, vn.address, vn.city,
      vn.confirmation_status, vn.submission_cluster_id, vn.created_by, vn.created_at,
      coalesce(p.username, '') as submitter_name,
      (select count(*) from public.venue_submission_affirmations a where a.affirmed_venue_id = vn.id) as affirmation_count
    from public.venues vn
    left join public.profiles p on p.id = vn.created_by
    where vn.confirmation_status = 'unconfirmed'
  ) t;
  return v_result;
end;
$$;
revoke all on function public.list_admin_venue_reviews() from public;
grant execute on function public.list_admin_venue_reviews() to authenticated;

-- 7. Admin (godmode) moderation action: save edits / confirm / reject.
create or replace function public.admin_review_venue(
  p_venue_id text,
  p_action text,
  p_name text default null,
  p_sports text[] default null,
  p_kind text default null,
  p_address text default null,
  p_city text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_row public.venues%rowtype;
begin
  if not public.is_godmode_user() then raise exception 'Admin access required'; end if;
  if p_action not in ('save', 'confirm', 'reject') then raise exception 'Invalid action'; end if;
  select * into v_row from public.venues where id = p_venue_id;
  if not found then raise exception 'Venue not found'; end if;
  if v_row.confirmation_status not in ('unconfirmed', 'rejected') then
    raise exception 'Venue is not in the review queue';
  end if;

  update public.venues set
    name    = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
    sport   = coalesce(p_sports, sport),
    kind    = coalesce(nullif(trim(coalesce(p_kind, '')), ''), kind),
    address = coalesce(nullif(trim(coalesce(p_address, '')), ''), address),
    city    = coalesce(nullif(trim(coalesce(p_city, '')), ''), city),
    confirmation_status = case p_action
      when 'confirm' then 'confirmed'
      when 'reject'  then 'rejected'
      else confirmation_status end
  where id = p_venue_id
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'confirmation_status', v_row.confirmation_status);
end;
$$;
revoke all on function public.admin_review_venue(text, text, text, text[], text, text, text) from public;
grant execute on function public.admin_review_venue(text, text, text, text[], text, text, text) to authenticated;

-- 8. Hide 'rejected' venues from search + radius (unconfirmed still show, ranked below).
create or replace function public.search_venues(
  p_query text,
  p_lat double precision default null,
  p_lng double precision default null,
  p_sports text[] default null,
  p_limit int default 8
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_term text;
  v_result jsonb;
begin
  v_term := lower(trim(p_query));
  if length(v_term) < 2 then
    return '[]'::jsonb;
  end if;

  select coalesce(
    jsonb_agg(row_to_json(t)::jsonb order by t.score desc, t.distance_meters asc nulls last),
    '[]'::jsonb
  )
  into v_result
  from (
    select
      s.id, s.name, s.address, s.city, s.lat, s.lng, s.kind, s.sport,
      s.confirmation_status,
      round(s.distance_meters::numeric, 1) as distance_meters,
      round(s.score::numeric, 2) as score
    from (
      select
        c.*,
        c.text_score
          + case when c.confirmation_status = 'confirmed' then 10 else 0 end
          + case
              when p_lat is not null and p_lng is not null and c.distance_meters is not null
                then 50.0 / (1.0 + c.distance_meters / 3000.0)
              else 0
            end as score
      from (
        select
          vn.id, vn.name, coalesce(vn.address, '') as address, vn.city,
          vn.lat, vn.lng, vn.kind, vn.sport, vn.confirmation_status,
          case
            when p_lat is not null and p_lng is not null
              then public.haversine_meters(p_lat, p_lng, vn.lat, vn.lng)
            else null
          end as distance_meters,
          case
            when lower(vn.name) = v_term then 100
            when lower(vn.name) like v_term || '%' then 80
            when lower(vn.name) like '%' || v_term || '%' then 60
            when lower(coalesce(vn.city, '')) like '%' || v_term || '%' then 40
            when lower(coalesce(vn.address, '')) like '%' || v_term || '%' then 35
            else 0
          end as text_score
        from public.venues vn
        where vn.confirmation_status <> 'rejected'
          and (p_sports is null or vn.sport && p_sports)
          and (
            lower(vn.name) like '%' || v_term || '%'
            or lower(coalesce(vn.city, '')) like '%' || v_term || '%'
            or lower(coalesce(vn.address, '')) like '%' || v_term || '%'
          )
      ) c
      where c.text_score > 0
    ) s
    limit greatest(p_limit, 1)
  ) t;

  return v_result;
end;
$$;
revoke all on function public.search_venues(text, double precision, double precision, text[], int) from public;
grant execute on function public.search_venues(text, double precision, double precision, text[], int) to authenticated;

create or replace function public.list_venues_in_radius(
  p_lat double precision,
  p_lng double precision,
  p_radius_meters double precision default 5000,
  p_limit int default 100,
  p_sports text[] default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_radius double precision := greatest(100, least(p_radius_meters, 80000));
  v_lim int := greatest(1, least(p_limit, 300));
begin
  if p_lat is null or p_lng is null then
    raise exception 'Coordinates required';
  end if;
  return coalesce((
    select jsonb_agg(sub.row order by sub.distance_meters asc)
    from (
      select jsonb_build_object(
        'id', v.id, 'name', v.name, 'kind', v.kind, 'sport', v.sport,
        'lat', v.lat, 'lng', v.lng, 'address', v.address, 'city', v.city,
        'surface', v.surface, 'indoor', v.indoor, 'lit', v.lit, 'covered', v.covered,
        'hoops', v.hoops, 'court_count', v.court_count, 'access', v.access, 'fee', v.fee,
        'operator', v.operator, 'website', v.website, 'phone', v.phone,
        'opening_hours', v.opening_hours, 'source', v.source, 'source_url', v.source_url,
        'attribution', v.attribution, 'confirmation_status', v.confirmation_status,
        'distance_meters', round(public.haversine_meters(p_lat, p_lng, v.lat, v.lng)::numeric, 1)
      ) as row,
      public.haversine_meters(p_lat, p_lng, v.lat, v.lng) as distance_meters
      from public.venues v
      where v.confirmation_status <> 'rejected'
        and (p_sports is null or v.sport && p_sports)
        and public.haversine_meters(p_lat, p_lng, v.lat, v.lng) <= v_radius
      order by public.haversine_meters(p_lat, p_lng, v.lat, v.lng) asc
      limit v_lim
    ) sub
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_venues_in_radius(double precision, double precision, double precision, int, text[]) from public;
grant execute on function public.list_venues_in_radius(double precision, double precision, double precision, int, text[]) to authenticated;

notify pgrst, 'reload schema';
