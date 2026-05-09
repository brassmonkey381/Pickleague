-- ============================================================
-- Court Locations
-- Run AFTER migration_add_match_metadata.sql (requires is_outdoor column)
-- ============================================================

-- ── 1. Create court_locations table ──────────────────────────
create table if not exists public.court_locations (
  id               uuid default gen_random_uuid() primary key,
  name             text not null unique,        -- matches location_name in matches
  address          text,
  lat              double precision,
  lng              double precision,
  has_outdoor      boolean not null default false,
  has_indoor       boolean not null default false,
  -- null = unknown/unclassified, true = outdoor is the go-to, false = indoor
  default_outdoor  boolean,
  surface_type     text check (surface_type in ('hard','clay','grass','carpet','other')),
  court_count      integer,
  notes            text,
  auto_classified  boolean not null default false,  -- set by keyword heuristic
  verified         boolean not null default false,  -- manually confirmed by a user
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

alter table public.court_locations enable row level security;
create policy "Court locations readable by everyone"
  on public.court_locations for select using (true);
create policy "Authenticated users can insert court locations"
  on public.court_locations for insert with check (auth.role() = 'authenticated');
create policy "Authenticated users can update court locations"
  on public.court_locations for update using (auth.role() = 'authenticated');

-- Auto-update updated_at
create or replace function public.touch_court_location()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger court_location_updated_at
  before update on public.court_locations
  for each row execute procedure public.touch_court_location();


-- ── 2. Back-fill matches.is_outdoor using location name keywords ──

-- OUTDOOR: parks, open-air venues, waterfront, fields
update public.matches
set is_outdoor = true
where is_outdoor is null
  and location_name is not null
  and (
       lower(location_name) like '%park%'
    or lower(location_name) like '%field%'
    or lower(location_name) like '% outdoor%'
    or lower(location_name) like 'outdoor %'
    or lower(location_name) like '%open air%'
    or lower(location_name) like '%open-air%'
    or lower(location_name) like '%beach%'
    or lower(location_name) like '%riverside%'
    or lower(location_name) like '%lakeside%'
    or lower(location_name) like '%waterfront%'
    or lower(location_name) like '%lakefront%'
    or lower(location_name) like '%commons%'
    or lower(location_name) like '%greenway%'
    or lower(location_name) like '%botanical%'
    or lower(location_name) like '%terrace%'
    or lower(location_name) like '%plaza%'
    or lower(location_name) like '%fairground%'
    or lower(location_name) like '%meadow%'
    or lower(location_name) like '%preserve%'
    or lower(location_name) like '%trail%'
    or lower(location_name) like '%nature%'
  )
  -- Exclude common false positives
  and lower(location_name) not like '%parking%'
  and lower(location_name) not like '%marketplace%'
  and lower(location_name) not like '%business park%'
  and lower(location_name) not like '%industrial park%'
  and lower(location_name) not like '%office park%'
  and lower(location_name) not like '%spark%';

-- INDOOR: rec centers, gyms, community/athletic facilities
update public.matches
set is_outdoor = false
where is_outdoor is null
  and location_name is not null
  and (
       lower(location_name) like '%rec center%'
    or lower(location_name) like '%recreation center%'
    or lower(location_name) like '%recreation complex%'
    or lower(location_name) like '%gymnasium%'
    or lower(location_name) like '%ymca%'
    or lower(location_name) like '%ywca%'
    or lower(location_name) like '%y.m.c.a%'
    or lower(location_name) like '%community center%'
    or lower(location_name) like '%sports center%'
    or lower(location_name) like '%sport center%'
    or lower(location_name) like '%athletic center%'
    or lower(location_name) like '%fitness center%'
    or lower(location_name) like '%fitness club%'
    or lower(location_name) like '%health club%'
    or lower(location_name) like '% indoor%'
    or lower(location_name) like 'indoor %'
    or lower(location_name) like '%fieldhouse%'
    or lower(location_name) like '%field house%'
    or lower(location_name) like '%arena%'
    or lower(location_name) like '%natatorium%'
    or lower(location_name) like '%aquatic center%'
    or lower(location_name) like '%aquatics%'
    or lower(location_name) like '%sports complex%'
    or lower(location_name) like '%sport complex%'
    or lower(location_name) like '%convention center%'
    or lower(location_name) like '%event center%'
    or lower(location_name) like '%racquet club%'
    or lower(location_name) like '%racket club%'
    or lower(location_name) like '%tennis club%'
    or lower(location_name) like '%country club%'
  );


-- ── 3. Seed court_locations from match history ────────────────
-- For each distinct location compute observed types and a majority default.
insert into public.court_locations (
  name, lat, lng,
  has_outdoor, has_indoor, default_outdoor,
  auto_classified
)
select
  location_name                                                     as name,
  avg(location_lat)                                                 as lat,
  avg(location_lng)                                                 as lng,
  coalesce(bool_or(is_outdoor = true),  false)                      as has_outdoor,
  coalesce(bool_or(is_outdoor = false), false)                      as has_indoor,
  case
    when count(*) filter (where is_outdoor is not null) = 0
      then null    -- no classification data yet
    when count(*) filter (where is_outdoor = true)::numeric
       / nullif(count(*) filter (where is_outdoor is not null), 0) >= 0.80
      then true    -- clearly outdoor
    when count(*) filter (where is_outdoor = false)::numeric
       / nullif(count(*) filter (where is_outdoor is not null), 0) >= 0.80
      then false   -- clearly indoor
    else null      -- mixed / too close to call
  end                                                               as default_outdoor,
  false                                                             as auto_classified  -- data-driven, not just a guess
from public.matches
where location_name is not null
  and trim(location_name) <> ''
group by location_name
on conflict (name) do nothing;


-- ── 4. Apply keyword heuristic to still-unclassified rows ─────
-- (locations that had no match data with is_outdoor set)

update public.court_locations
set
  has_outdoor     = true,
  default_outdoor = true,
  auto_classified = true
where default_outdoor is null
  and verified = false
  and (
       lower(name) like '%park%'
    or lower(name) like '%field%'
    or lower(name) like '% outdoor%'
    or lower(name) like 'outdoor %'
    or lower(name) like '%open air%'
    or lower(name) like '%beach%'
    or lower(name) like '%commons%'
    or lower(name) like '%greenway%'
    or lower(name) like '%riverside%'
    or lower(name) like '%lakeside%'
    or lower(name) like '%waterfront%'
    or lower(name) like '%botanical%'
    or lower(name) like '%preserve%'
    or lower(name) like '%meadow%'
    or lower(name) like '%fairground%'
    or lower(name) like '%nature%'
  )
  and lower(name) not like '%parking%'
  and lower(name) not like '%business park%'
  and lower(name) not like '%industrial park%'
  and lower(name) not like '%marketplace%';

update public.court_locations
set
  has_indoor      = true,
  default_outdoor = false,
  auto_classified = true
where default_outdoor is null
  and verified = false
  and (
       lower(name) like '%rec center%'
    or lower(name) like '%recreation center%'
    or lower(name) like '%gymnasium%'
    or lower(name) like '%ymca%'
    or lower(name) like '%ywca%'
    or lower(name) like '%community center%'
    or lower(name) like '%sports center%'
    or lower(name) like '%athletic center%'
    or lower(name) like '%fitness center%'
    or lower(name) like '%fitness club%'
    or lower(name) like '% indoor%'
    or lower(name) like 'indoor %'
    or lower(name) like '%fieldhouse%'
    or lower(name) like '%arena%'
    or lower(name) like '%aquatic%'
    or lower(name) like '%racquet club%'
    or lower(name) like '%country club%'
  );


-- ── 5. Trigger: auto-learn from every future match insert ─────
-- When a match is recorded with is_outdoor set, update (or create)
-- the court_locations row to note which types of courts exist there.
-- Uses OR-merge so has_outdoor/has_indoor are never cleared to false.

create or replace function public.learn_court_from_match()
returns trigger language plpgsql security definer as $$
begin
  if new.location_name is not null and new.is_outdoor is not null then
    insert into public.court_locations (
      name, lat, lng,
      has_outdoor, has_indoor, default_outdoor,
      auto_classified
    ) values (
      new.location_name,
      new.location_lat,
      new.location_lng,
      new.is_outdoor = true,
      new.is_outdoor = false,
      new.is_outdoor,   -- first observation sets the default
      false
    )
    on conflict (name) do update set
      has_outdoor = court_locations.has_outdoor or (new.is_outdoor = true),
      has_indoor  = court_locations.has_indoor  or (new.is_outdoor = false),
      lat         = coalesce(court_locations.lat, new.location_lat),
      lng         = coalesce(court_locations.lng, new.location_lng),
      updated_at  = now();
      -- default_outdoor intentionally not changed after first set
  end if;
  return new;
end;
$$;

create trigger on_match_learn_court
  after insert on public.matches
  for each row execute procedure public.learn_court_from_match();
