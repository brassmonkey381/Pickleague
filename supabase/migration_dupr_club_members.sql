-- DUPR club roster ingest.
--
-- Mirrors what api.dupr.gg returns for POST /club/{clubId}/members/v1.0/all.
-- Every column sourced from DUPR carries a dupr_ prefix so provenance is obvious
-- at a glance and nothing here is ever confused with a Pickleague-owned value.
--
-- This table holds real member PII (email, phone, home lat/lng, birthdate) for
-- people who joined a DUPR club — not a public directory. RLS below is therefore
-- deny-by-default: godmode reads everything, a signed-in user reads only the row
-- linked to their own profile, and nobody but the service role writes.

create table if not exists public.dupr_club_members (
  id                        bigint generated always as identity primary key,

  -- Club scope
  dupr_club_id              bigint not null,
  dupr_club_name            text,

  -- Identity. dupr_member_id is DUPR's internal numeric id (stable, used for
  -- upsert); dupr_id is the short public code shown in the app (e.g. "QXDJXN").
  dupr_member_id            bigint not null,
  dupr_id                   text,
  dupr_full_name            text,
  dupr_username             text,

  -- Contact PII
  dupr_email                text,
  dupr_verified_email       boolean,
  dupr_phone                text,
  dupr_verified_phone       boolean,

  -- Location PII
  dupr_short_address        text,
  dupr_formatted_address    text,
  dupr_latitude             double precision,
  dupr_longitude            double precision,
  dupr_iso_alpha2_code      text,

  -- Demographics
  dupr_gender               text,
  dupr_birthdate            date,
  dupr_age                  integer,
  dupr_hand                 text,
  dupr_image_url            text,

  -- Ratings. DUPR sends these as strings and uses "NR" for unrated, so the
  -- numeric columns are null when unrated and dupr_*_raw keeps what was sent.
  -- dupr_*_verified is likewise a status STRING (e.g. "NR"), not a boolean.
  dupr_singles              numeric(4,2),
  dupr_singles_raw          text,
  dupr_singles_verified     text,
  dupr_singles_provisional  boolean,
  dupr_singles_reliability  integer,
  dupr_provisional_singles_rating numeric(4,2),

  dupr_doubles              numeric(4,2),
  dupr_doubles_raw          text,
  dupr_doubles_verified     text,
  dupr_doubles_provisional  boolean,
  dupr_doubles_reliability  integer,
  dupr_provisional_doubles_rating numeric(4,2),

  dupr_default_rating       text,

  -- Membership metadata. roles is an array of objects
  -- ({roleId, role, approvalStatus, clubId, created, requestBy, joinType}), so it
  -- is kept as jsonb with the club-scoped role flattened out for easy filtering.
  dupr_status               text,
  dupr_roles                jsonb,
  dupr_role                 text,
  dupr_role_approval_status text,
  dupr_join_type            text,
  dupr_enable_privacy       boolean,
  dupr_created              timestamptz,

  -- Full payload, so a later field we didn't model is never lost to a re-pull.
  dupr_raw                  jsonb not null,

  -- Link to a Pickleague account, when we can establish one.
  profile_id                uuid references public.profiles(id) on delete set null,
  matched_by                text check (matched_by in ('dupr_id', 'email', 'name')),

  first_seen_at             timestamptz not null default now(),
  last_synced_at            timestamptz not null default now(),

  unique (dupr_club_id, dupr_member_id)
);

create index if not exists dupr_club_members_club_idx    on public.dupr_club_members (dupr_club_id);
create index if not exists dupr_club_members_dupr_id_idx on public.dupr_club_members (dupr_id);
create index if not exists dupr_club_members_profile_idx on public.dupr_club_members (profile_id) where profile_id is not null;
-- Not used for account matching (that is dupr_id only) — this exists so ad-hoc
-- "is this person in the club?" lookups by email don't seq-scan the roster.
create index if not exists dupr_club_members_email_idx   on public.dupr_club_members (lower(dupr_email));

-- A Pickleague user can claim their own DUPR code; that's what lets the importer
-- link a roster row to an account without touching email at all.
alter table public.profiles add column if not exists dupr_id text;
create unique index if not exists profiles_dupr_id_key on public.profiles (dupr_id) where dupr_id is not null;

alter table public.dupr_club_members enable row level security;

-- Deny by default: no anon access at all, and no INSERT/UPDATE/DELETE policy for
-- authenticated — the importer writes with the service-role key, which bypasses RLS.
drop policy if exists "Godmode reads dupr club members" on public.dupr_club_members;
create policy "Godmode reads dupr club members"
  on public.dupr_club_members for select
  to authenticated
  using (public.is_godmode_user());

drop policy if exists "Users read their own dupr club row" on public.dupr_club_members;
create policy "Users read their own dupr club row"
  on public.dupr_club_members for select
  to authenticated
  using (profile_id = auth.uid());

revoke all on public.dupr_club_members from anon;
grant select on public.dupr_club_members to authenticated;
