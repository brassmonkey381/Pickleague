-- PKL-088: a "Gender neutral" tournament setting (any format).
--   * tournaments.gender_neutral (default false). The host sets it on create, or edits it until the draw: the
--     guard below refuses a change once the tournament has left registration, has matches, or has a locked team,
--     and refuses turning it off while a team holds a player in a slot that doesn't match their gender.
--   * MLP: a team is any 4 players. The 4 slot columns stay (male_1, male_2, female_1, female_2) and simply mean
--     slots 1-4; create_mlp_team needs no gender, a join fills the first open slot (no "Both male slots are full"),
--     mlp_set_slot skips the gender check, and random teams pool everyone together. Locking still needs all 4.
--     The schedule is unchanged (games 1-4 by slot pairs, then the Dreambreaker); the app names them Doubles 1-4.
--   * PLUPR: a gender-neutral doubles game moves only the overall PLUPR (plupr_category 'overall'); doubles_rating
--     and mixed_doubles_rating never move, and a player with no gender set no longer blocks the rating. Singles
--     is unchanged (overall + singles_rating). The Dreambreaker stays out of PLUPR (PKL-086).
-- Apply: supabase db query --linked -f supabase/migration_tournament_gender_neutral.sql

alter table public.tournaments add column if not exists gender_neutral boolean not null default false;

create or replace function public._pl_gender_neutral_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.gender_neutral is not distinct from old.gender_neutral then return new; end if;
  if old.status <> 'registration'
     or exists (select 1 from public.tournament_matches m where m.tournament_id = old.id)
     or exists (select 1 from public.mlp_teams t where t.tournament_id = old.id and t.status = 'locked') then
    raise exception 'Gender neutral can only change before the draw (no matches and no locked teams yet)'
      using errcode = '22023';
  end if;
  if not new.gender_neutral and exists (
    select 1 from public.mlp_teams t
      join public.profiles p on p.id in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
     where t.tournament_id = old.id
       and ((p.gender = 'female' and p.id in (t.male_1_id, t.male_2_id))
         or (p.gender in ('male', 'other') and p.id in (t.female_1_id, t.female_2_id)))
  ) then
    raise exception 'A team has players in slots that need 2 men and 2 women. Fix the teams first, or keep it gender neutral'
      using errcode = '22023';
  end if;
  return new;
end $function$;
revoke execute on function public._pl_gender_neutral_guard() from public, anon, authenticated;

drop trigger if exists trg_pl_gender_neutral_guard on public.tournaments;
create trigger trg_pl_gender_neutral_guard
  before update of gender_neutral on public.tournaments
  for each row execute function public._pl_gender_neutral_guard();

-- ── _pl_tm_plupr ──
CREATE OR REPLACE FUNCTION public._pl_tm_plupr()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  GLOBAL_WEIGHT constant numeric := 0.5;
  v_is      boolean;
  v_was     boolean := false;
  v_changed boolean := false;
  v_league  uuid;
  v_w       numeric;
  r1 numeric; r_p1 numeric := 3.250;
  r2 numeric; r_p2 numeric := 3.250;
  t1avg numeric; t2avg numeric;
  cat text; fcat text;
  v_neutral boolean := false;
  p1_count integer;
  s1 integer; s2 integer;
  d1 numeric;
  v_r jsonb := '{}'::jsonb;
begin
  if tg_op = 'DELETE' then
    if old.plupr_applied_at is not null then
      perform public._pl_tm_reverse_row(old.plupr_league_id, old.plupr_category, old.plupr_ratings);
    end if;
    return old;
  end if;

  -- Server-owned columns: whatever a client sent is replaced.
  if tg_op = 'INSERT' then
    new.completed_at := null;
    new.plupr_delta := null; new.plupr_league_id := null; new.plupr_global_weight := null;
    new.plupr_category := null; new.plupr_ratings := null; new.plupr_applied_at := null;
  else
    new.completed_at := old.completed_at;
    new.plupr_delta := old.plupr_delta; new.plupr_league_id := old.plupr_league_id;
    new.plupr_global_weight := old.plupr_global_weight; new.plupr_category := old.plupr_category;
    new.plupr_ratings := old.plupr_ratings; new.plupr_applied_at := old.plupr_applied_at;
    v_was := old.status = 'completed' and old.winner_team is not null
             and old.team1_player1 is not null and old.team2_player1 is not null;
  end if;

  v_is := new.status = 'completed' and new.winner_team in ('team1', 'team2')
          and new.team1_player1 is not null and new.team2_player1 is not null
          and not (coalesce(new.is_dreambreaker, false) and new.db_order_team1 is not null); -- PKL-086: a rotating Dreambreaker moves no one's PLUPR

  if tg_op = 'UPDATE' and v_was and v_is then
    v_changed := (new.team1_score, new.team2_score, new.winner_team, new.match_type,
                  new.team1_player1, new.team1_player2, new.team2_player1, new.team2_player2,
                  new.team1_player1_gender_override, new.team1_player2_gender_override,
                  new.team2_player1_gender_override, new.team2_player2_gender_override)
                 is distinct from
                 (old.team1_score, old.team2_score, old.winner_team, old.match_type,
                  old.team1_player1, old.team1_player2, old.team2_player1, old.team2_player2,
                  old.team1_player1_gender_override, old.team1_player2_gender_override,
                  old.team2_player1_gender_override, old.team2_player2_gender_override);
    if not v_changed then return new; end if;            -- a re-save: nothing to do
    if old.plupr_applied_at is null then return new; end if;  -- completed before this file (or unspecified doubles): leave it
  end if;

  -- Undo what this row applied when it stops counting or its result changed.
  if tg_op = 'UPDATE' and old.plupr_applied_at is not null and (not v_is or v_changed) then
    perform public._pl_tm_reverse_row(old.plupr_league_id, old.plupr_category, old.plupr_ratings);
    new.plupr_delta := null; new.plupr_league_id := null; new.plupr_global_weight := null;
    new.plupr_category := null; new.plupr_ratings := null; new.plupr_applied_at := null;
  end if;

  if not v_is then
    new.completed_at := null;
    return new;
  end if;
  if not v_was then new.completed_at := now(); end if;

  -- Apply. Same rating math as update_plupr_for_tournament_match.
  select league_id, coalesce(gender_neutral, false) into v_league, v_neutral from public.tournaments where id = new.tournament_id;
  v_w := case when v_league is not null then GLOBAL_WEIGHT else 1.0 end;

  select rating into r1 from public.profiles where id = new.team1_player1;
  select rating into r2 from public.profiles where id = new.team2_player1;
  if new.match_type = 'doubles' then
    if new.team1_player2 is not null then select rating into r_p1 from public.profiles where id = new.team1_player2; end if;
    if new.team2_player2 is not null then select rating into r_p2 from public.profiles where id = new.team2_player2; end if;
    t1avg := (r1 + r_p1) / 2.0;
    t2avg := (r2 + r_p2) / 2.0;
    cat := public._classify_doubles_with_overrides(
      new.team1_player1, new.team1_player1_gender_override,
      new.team1_player2, new.team1_player2_gender_override,
      new.team2_player1, new.team2_player1_gender_override,
      new.team2_player2, new.team2_player2_gender_override);
    fcat := cat;
    -- PKL-088: gender neutral. Genders don't matter, so the game counts even with a gender unset, and only the
    -- overall PLUPR moves: the _apply/_reverse helpers touch no facet column for 'overall'.
    if v_neutral then cat := 'overall'; fcat := 'overall'; end if;
  else
    t1avg := r1; t2avg := r2; cat := null; fcat := 'singles';
  end if;

  new.plupr_category := fcat;
  if new.match_type = 'doubles' and cat = 'unspecified' then return new; end if;

  select coalesce(total_matches_played, 0) into p1_count from public.profiles where id = new.team1_player1;
  -- A correction: this match is already in the count; K reads the count before it.
  if v_was then p1_count := greatest(0, p1_count - 1); end if;

  if new.winner_team = 'team1' then
    s1 := coalesce(new.team1_score, 11); s2 := coalesce(new.team2_score, 7);
  else
    s1 := coalesce(new.team1_score, 7);  s2 := coalesce(new.team2_score, 11);
  end if;

  d1 := public._plupr_delta(p1_count,
          ((s1 - s2)::numeric - public._plupr_expected_diff(t1avg, t2avg)) / 10.0);

  v_r := v_r || jsonb_build_object(new.team1_player1::text,
           public._pl_tm_apply_one(v_league, new.team1_player1, d1, v_w, fcat));
  v_r := v_r || jsonb_build_object(new.team2_player1::text,
           public._pl_tm_apply_one(v_league, new.team2_player1, -d1, v_w, fcat));
  if new.match_type = 'doubles' then
    if new.team1_player2 is not null then
      v_r := v_r || jsonb_build_object(new.team1_player2::text,
               public._pl_tm_apply_one(v_league, new.team1_player2, d1, v_w, fcat));
    end if;
    if new.team2_player2 is not null then
      v_r := v_r || jsonb_build_object(new.team2_player2::text,
               public._pl_tm_apply_one(v_league, new.team2_player2, -d1, v_w, fcat));
    end if;
  end if;

  -- League W-L by the match result (PKL-048). Each entry records it so a
  -- correction or delete takes back exactly what was added.
  if v_league is not null then
    perform public._pl_league_wl(v_league, new.team1_player1, new.winner_team = 'team1', 1);
    perform public._pl_league_wl(v_league, new.team2_player1, new.winner_team = 'team2', 1);
    v_r := jsonb_set(v_r, array[new.team1_player1::text, 'won'], to_jsonb(new.winner_team = 'team1'));
    v_r := jsonb_set(v_r, array[new.team2_player1::text, 'won'], to_jsonb(new.winner_team = 'team2'));
    if new.match_type = 'doubles' then
      if new.team1_player2 is not null then
        perform public._pl_league_wl(v_league, new.team1_player2, new.winner_team = 'team1', 1);
        v_r := jsonb_set(v_r, array[new.team1_player2::text, 'won'], to_jsonb(new.winner_team = 'team1'));
      end if;
      if new.team2_player2 is not null then
        perform public._pl_league_wl(v_league, new.team2_player2, new.winner_team = 'team2', 1);
        v_r := jsonb_set(v_r, array[new.team2_player2::text, 'won'], to_jsonb(new.winner_team = 'team2'));
      end if;
    end if;
  end if;

  new.plupr_delta := d1;
  new.plupr_league_id := v_league;
  new.plupr_global_weight := v_w;
  new.plupr_ratings := v_r;
  new.plupr_applied_at := now();
  return new;
end $function$;

-- ── create_mlp_team ──
CREATE OR REPLACE FUNCTION public.create_mlp_team(p_tournament_id uuid, p_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid       uuid := auth.uid();
  v_format    text;
  v_team_id   uuid;
  v_existing  uuid;
  v_gender    text;
  v_male1     uuid := null;
  v_male2     uuid := null;
  v_female1   uuid := null;
  v_female2   uuid := null;
  v_neutral   boolean;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if length(coalesce(trim(p_name), '')) = 0 then raise exception 'Team name required'; end if;

  select format, coalesce(gender_neutral, false) into v_format, v_neutral from public.tournaments where id = p_tournament_id;
  if v_format is null then raise exception 'Tournament not found'; end if;
  if v_format <> 'mlp' then raise exception 'Only MLP Fixed Teams tournaments accept self-formed teams'; end if;

  if not exists (
    select 1 from public.tournament_registrations
     where tournament_id = p_tournament_id and user_id = v_uid and status = 'approved'
  ) then
    raise exception 'You must be approved into this tournament before creating a team';
  end if;

  select id into v_existing from public.mlp_teams
   where tournament_id = p_tournament_id
     and v_uid in (captain_id, male_1_id, male_2_id, female_1_id, female_2_id)
   limit 1;
  if v_existing is not null then
    raise exception 'You''re already on a team in this tournament';
  end if;

  -- Captain auto-slots based on their gender (male/other -> male_1, female -> female_1).
  select gender into v_gender from public.profiles where id = v_uid;
  if v_neutral then
    v_male1 := v_uid;   -- PKL-088: gender neutral, any 4 players; slot 1
  elsif v_gender is null or v_gender = 'prefer-not-to-say' then
    raise exception 'Set your gender (male/female/other) on your profile before creating a team';
  elsif v_gender = 'female' then v_female1 := v_uid;
  else                        v_male1   := v_uid;
  end if;

  insert into public.mlp_teams (
    tournament_id, name, captain_id, male_1_id, male_2_id, female_1_id, female_2_id
  ) values (
    p_tournament_id, trim(p_name), v_uid, v_male1, v_male2, v_female1, v_female2
  ) returning id into v_team_id;

  return v_team_id;
end;
$function$;

-- ── generate_random_mlp_teams ──
CREATE OR REPLACE FUNCTION public.generate_random_mlp_teams(p_tournament_id uuid, p_mode text DEFAULT 'random'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid              uuid := auth.uid();
  v_format           text;
  v_team_count       integer;
  v_total            integer;
  v_pure_males       uuid[];
  v_pure_females     uuid[];
  v_wildcards        uuid[];
  v_remaining_names  text[];
  v_team_name        text;
  v_male_pool        uuid[];
  v_female_pool      uuid[];
  v_need_male        integer;
  v_need_female      integer;
  v_short_male       integer;
  v_short_female     integer;
  v_wild_avail       integer;
  v_wild_to_male     integer;
  v_wild_to_female   integer;
  v_extras           integer;
  v_male_1           uuid;
  v_male_2           uuid;
  v_female_1         uuid;
  v_female_2         uuid;
  i                  integer;
  v_order_clause     text;
  v_neutral          boolean;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public._is_tournament_admin(p_tournament_id, v_uid) then
    raise exception 'Only tournament admins can generate teams';
  end if;

  select format, coalesce(gender_neutral, false) into v_format, v_neutral from public.tournaments where id = p_tournament_id;
  if v_format <> 'mlp_random' then
    raise exception 'Use this only for MLP / Random Teams tournaments (got %)', v_format;
  end if;

  -- Reset any prior teams.
  delete from public.mlp_teams where tournament_id = p_tournament_id;

  -- ── 1. Bucket players by gender, ordered by mode. ─────────────────
  -- 'snake' orders by PLUPR desc within each bucket so the snake-draft
  -- pairs strongest with weakest. 'random' shuffles each bucket.
  if p_mode = 'snake' then
    select array_agg(tr.user_id order by p.rating desc) into v_pure_males
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and not v_neutral and p.gender in ('male', 'other');
    select array_agg(tr.user_id order by p.rating desc) into v_pure_females
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and not v_neutral and p.gender = 'female';
    select array_agg(tr.user_id order by p.rating desc) into v_wildcards
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and (v_neutral or p.gender is null or p.gender = 'prefer-not-to-say');
  else
    select array_agg(tr.user_id order by random()) into v_pure_males
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and not v_neutral and p.gender in ('male', 'other');
    select array_agg(tr.user_id order by random()) into v_pure_females
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and not v_neutral and p.gender = 'female';
    select array_agg(tr.user_id order by random()) into v_wildcards
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and (v_neutral or p.gender is null or p.gender = 'prefer-not-to-say');
  end if;

  v_pure_males   := coalesce(v_pure_males,   '{}'::uuid[]);
  v_pure_females := coalesce(v_pure_females, '{}'::uuid[]);
  v_wildcards    := coalesce(v_wildcards,    '{}'::uuid[]);

  v_total := cardinality(v_pure_males)
           + cardinality(v_pure_females)
           + cardinality(v_wildcards);
  v_team_count := v_total / 4;

  if v_team_count < 2 then
    raise exception 'Need at least 8 approved players for 2 teams (got %)', v_total;
  end if;

  -- ── 2. Decide where each wildcard goes ────────────────────────────
  v_need_male    := v_team_count * 2;
  v_need_female  := v_team_count * 2;
  v_short_male   := greatest(0, v_need_male   - cardinality(v_pure_males));
  v_short_female := greatest(0, v_need_female - cardinality(v_pure_females));
  v_wild_avail   := cardinality(v_wildcards);

  -- Pour wildcards into the shorter side first; any leftover splits evenly.
  if v_short_male + v_short_female <= v_wild_avail then
    v_wild_to_male   := v_short_male;
    v_wild_to_female := v_short_female;
    -- Distribute any leftover wildcards as evenly as possible.
    v_extras := v_wild_avail - v_wild_to_male - v_wild_to_female;
    v_wild_to_male   := v_wild_to_male   + (v_extras / 2);
    v_wild_to_female := v_wild_to_female + (v_extras - v_extras / 2);
  else
    -- Not enough wildcards to cover both shortfalls — give to the side that
    -- needs more, proportionally.
    if v_short_male = 0 then
      v_wild_to_male := 0;
      v_wild_to_female := v_wild_avail;
    elsif v_short_female = 0 then
      v_wild_to_male := v_wild_avail;
      v_wild_to_female := 0;
    else
      v_wild_to_male := round(v_wild_avail::numeric
                              * v_short_male / (v_short_male + v_short_female))::int;
      v_wild_to_female := v_wild_avail - v_wild_to_male;
    end if;
  end if;

  -- ── 3. Build the male / female slot pools ─────────────────────────
  v_male_pool   := v_pure_males   || v_wildcards[1:v_wild_to_male];
  v_female_pool := v_pure_females || v_wildcards[(v_wild_to_male + 1):(v_wild_to_male + v_wild_to_female)];

  -- ── 4. Pull a shuffled batch of unique team names ─────────────────
  select array_agg(name order by random()) into v_remaining_names
    from (
      select name from public.mlp_team_name_pool order by random() limit v_team_count
    ) s;

  -- ── 5. Create the teams ───────────────────────────────────────────
  for i in 1 .. v_team_count loop
    if p_mode = 'snake' then
      v_male_1   := v_male_pool  [i];
      v_male_2   := v_male_pool  [2 * v_team_count - i + 1];
      v_female_1 := v_female_pool[i];
      v_female_2 := v_female_pool[2 * v_team_count - i + 1];
    else
      v_male_1   := v_male_pool  [(i - 1) * 2 + 1];
      v_male_2   := v_male_pool  [(i - 1) * 2 + 2];
      v_female_1 := v_female_pool[(i - 1) * 2 + 1];
      v_female_2 := v_female_pool[(i - 1) * 2 + 2];
    end if;

    v_team_name := coalesce(v_remaining_names[i], 'Team ' || i);

    -- Insert the team. Empty slots are allowed (legacy column nullability)
    -- so partial teams are still written when wildcards weren't enough.
    insert into public.mlp_teams (
      tournament_id, name, status, is_random_generated,
      male_1_id, male_2_id, female_1_id, female_2_id
    ) values (
      p_tournament_id, v_team_name, 'locked', true,
      v_male_1, v_male_2, v_female_1, v_female_2
    );
  end loop;

  return v_team_count;
end;
$function$;

-- ── mlp_respond_to_join ──
CREATE OR REPLACE FUNCTION public.mlp_respond_to_join(p_request_id uuid, p_accept boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid             uuid := auth.uid();
  v_req             record;
  v_team            record;
  v_gender          text;
  v_target_slot     text;
  v_responder_name  text;
  v_tournament_name text;
  v_god             boolean := public.is_godmode_user();
  v_male_open       integer;
  v_female_open     integer;
  v_neutral         boolean;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_req from public.mlp_team_join_requests where id = p_request_id;
  if v_req.id is null then raise exception 'Request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'Request already %', v_req.status; end if;

  select * into v_team from public.mlp_teams where id = v_req.team_id;
  if v_team.id is null then raise exception 'Team not found'; end if;
  if v_team.status <> 'forming' then raise exception 'Team is locked'; end if;

  -- Godmode bypass: caller doesn't need to be the invitee or captain.
  if not v_god then
    if v_req.direction = 'invite' then
      if v_uid <> v_req.user_id then raise exception 'Only the invitee can respond'; end if;
    else
      if v_uid <> v_team.captain_id then raise exception 'Only the captain can respond'; end if;
    end if;
  end if;

  if not p_accept then
    update public.mlp_team_join_requests
       set status = 'declined', responded_at = now()
     where id = p_request_id;
    return;
  end if;

  -- Accept path
  if not exists (
    select 1 from public.tournament_registrations
     where tournament_id = v_team.tournament_id and user_id = v_req.user_id and status = 'approved'
  ) then
    raise exception 'User is no longer approved into the tournament';
  end if;
  if exists (
    select 1 from public.mlp_teams
     where tournament_id = v_team.tournament_id
       and id <> v_team.id
       and v_req.user_id in (captain_id, male_1_id, male_2_id, female_1_id, female_2_id)
  ) then
    raise exception 'User is already on another team';
  end if;

  select gender into v_gender from public.profiles where id = v_req.user_id;
  select coalesce(gender_neutral, false) into v_neutral from public.tournaments where id = v_team.tournament_id;
  -- ── Slot assignment ─────────────────────────────────────────────────
  -- Pure female → female slot. Pure male/other → male slot. Wildcards
  -- (null / prefer-not-to-say) fill whichever side has MORE open
  -- slots, defaulting to male on a tie. This matches the random
  -- generator's wildcard balancing.
  if v_neutral then
    -- PKL-088: gender neutral, any 4 players: the first open slot.
    if    v_team.male_1_id   is null then v_target_slot := 'male_1';
    elsif v_team.male_2_id   is null then v_target_slot := 'male_2';
    elsif v_team.female_1_id is null then v_target_slot := 'female_1';
    elsif v_team.female_2_id is null then v_target_slot := 'female_2';
    else  raise exception 'Team is full';
    end if;
  elsif v_gender = 'female' then
    if    v_team.female_1_id is null then v_target_slot := 'female_1';
    elsif v_team.female_2_id is null then v_target_slot := 'female_2';
    else  raise exception 'Both female slots are full';
    end if;
  elsif v_gender in ('male', 'other') then
    if    v_team.male_1_id is null then v_target_slot := 'male_1';
    elsif v_team.male_2_id is null then v_target_slot := 'male_2';
    else  raise exception 'Both male slots are full';
    end if;
  else
    -- Wildcard: pick the side with more open slots.
    v_male_open := (case when v_team.male_1_id   is null then 1 else 0 end)
                 + (case when v_team.male_2_id   is null then 1 else 0 end);
    v_female_open := (case when v_team.female_1_id is null then 1 else 0 end)
                   + (case when v_team.female_2_id is null then 1 else 0 end);

    if v_male_open + v_female_open = 0 then
      raise exception 'Team is full';
    end if;

    if v_male_open >= v_female_open then
      if    v_team.male_1_id   is null then v_target_slot := 'male_1';
      elsif v_team.male_2_id   is null then v_target_slot := 'male_2';
      elsif v_team.female_1_id is null then v_target_slot := 'female_1';
      else                                  v_target_slot := 'female_2';
      end if;
    else
      if    v_team.female_1_id is null then v_target_slot := 'female_1';
      elsif v_team.female_2_id is null then v_target_slot := 'female_2';
      elsif v_team.male_1_id   is null then v_target_slot := 'male_1';
      else                                  v_target_slot := 'male_2';
      end if;
    end if;
  end if;

  execute format('update public.mlp_teams set %I_id = $1 where id = $2', v_target_slot)
    using v_req.user_id, v_team.id;

  update public.mlp_team_join_requests
     set status = 'accepted', responded_at = now()
   where id = p_request_id;

  select p.full_name into v_responder_name from public.profiles p where p.id = v_req.user_id;
  select t.name      into v_tournament_name from public.tournaments t where t.id = v_team.tournament_id;

  if v_req.direction = 'invite' then
    -- Invitee accepted (or godmode forced) → notify captain
    if v_team.captain_id is not null and v_team.captain_id <> v_uid then
      perform public._notify_user(
        v_team.captain_id,
        'Invite accepted',
        format('%s joined %s in %s.',
               coalesce(v_responder_name, 'A player'), v_team.name, v_tournament_name),
        v_team.tournament_id,
        'tournament'
      );
    end if;
  else
    -- Captain accepted → notify the requester
    perform public._notify_user(
      v_req.user_id,
      'Join request accepted',
      format('Your request to join %s in %s was accepted.',
             v_team.name, v_tournament_name),
      v_team.tournament_id,
      'tournament'
    );
  end if;
end;
$function$;

-- ── mlp_set_slot ──
CREATE OR REPLACE FUNCTION public.mlp_set_slot(p_team_id uuid, p_slot text, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid    uuid := auth.uid();
  v_team   record;
  v_gender text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_slot not in ('male_1','male_2','female_1','female_2') then
    raise exception 'Invalid slot %', p_slot;
  end if;

  select * into v_team from public.mlp_teams where id = p_team_id;
  if v_team.id is null then raise exception 'Team not found'; end if;
  if v_uid <> v_team.captain_id and not public._is_tournament_admin(v_team.tournament_id, v_uid) then
    raise exception 'Only the captain or a tournament admin can change slots';
  end if;
  if v_team.status <> 'forming' then raise exception 'Team is locked'; end if;

  if p_user_id is not null and not exists (
    select 1 from public.tournaments where id = v_team.tournament_id and coalesce(gender_neutral, false)
  ) then
    select gender into v_gender from public.profiles where id = p_user_id;

    if p_slot in ('female_1', 'female_2') then
      if v_gender = 'male' or v_gender = 'other' then
        raise exception 'Cannot place a % player in slot %', v_gender, p_slot;
      end if;
    else
      if v_gender = 'female' then
        raise exception 'Cannot place a female player in slot %', p_slot;
      end if;
    end if;
  end if;

  execute format('update public.mlp_teams set %I_id = $1 where id = $2', p_slot)
    using p_user_id, p_team_id;
end;
$function$;
