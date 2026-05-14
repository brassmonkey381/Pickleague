-- ============================================================
-- Auto-advance DOUBLE-elimination brackets.
--
-- Why: `generateDoubleElim` only emits the WB round-1 pairings.
-- The full WB advancement, LB creation/advancement, and grand
-- finals (including optional bracket reset) are handled here in
-- the database so the client doesn't have to know the rules.
--
-- ── Round numbering ───────────────────────────────────────────
-- We piggy-back on `tournament_rounds.round_number` but split it
-- by `round_type`. There's no unique constraint on (tid, number),
-- so each bracket gets its own 1..N counter:
--
--   round_type='winners'      → round_number 1..K (K = log2(bracket))
--   round_type='finals'       → reserved for single-elim; NEVER
--                               used by double-elim (the WB final
--                               stays round_type='winners')
--   round_type='losers'       → round_number 1..(2K-2)
--                                  odd LB rounds = consolidation
--                                  even LB rounds = drop-in
--                                  (LB R1 = first WB R1 losers drop-in
--                                   is the special case)
--   round_type='grand_final'  → round_number 1 (and 2 on reset)
--
-- ── LB structure (standard double-elim) ───────────────────────
--   LB R1  ← WB R1 losers paired together
--   LB R2  ← LB R1 winners vs WB R2 losers     (drop-in)
--   LB R3  ← LB R2 winners paired              (consolidation)
--   LB R4  ← LB R3 winners vs WB R3 losers     (drop-in)
--   LB R5  ← LB R4 winners paired              (consolidation)
--   ...
--   LB final ← 1 winner = the LB grand finalist
--
-- The mapping is: WB R(X) losers drop into LB R(2X-2) for X>=2.
-- (WB R1 losers go straight into LB R1.)
--
-- ── Grand final + optional bracket reset ──────────────────────
-- After both bracket finals complete:
--   GF1 created with team1 = WB finalist, team2 = LB finalist.
-- If team1 (WB finalist) wins GF1 → champion, tournament done.
-- If team2 (LB finalist) wins GF1 → bracket RESET: the WB finalist
--   has now lost once (their first loss), so we force GF2 to keep
--   the "must beat them twice" property. Whoever wins GF2 wins.
--
-- We DO implement bracket reset. Rationale: it's the standard
-- TOC/championship-level interpretation of double-elim and the
-- whole point of having WB+LB structure is that the WB finalist
-- earns a one-loss buffer. Disabling reset would silently demote
-- the format. If a future tournament wants no-reset, gate it
-- behind a tournament column rather than removing this code.
--
-- ── Idempotency ───────────────────────────────────────────────
-- Every insert is guarded by an "does this round/match already
-- exist?" lookup so the trigger is safe under concurrent updates
-- and re-fires (e.g. score corrections).
--
-- ── Errors ────────────────────────────────────────────────────
-- Everything inside an EXCEPTION block — a wonky state must not
-- block the score update itself.
-- ============================================================


-- 1. round_type constraint must permit 'grand_final' ----------
do $$
declare v_con text;
begin
  select conname into v_con
    from pg_constraint
   where conrelid = 'public.tournament_rounds'::regclass
     and conname = 'tournament_rounds_round_type_check';
  if v_con is not null then
    execute format('alter table public.tournament_rounds drop constraint %I', v_con);
  end if;
end $$;

alter table public.tournament_rounds
  add constraint tournament_rounds_round_type_check
  check (round_type in (
    'pool','winners','losers','quarterfinals','semifinals','finals',
    'consolation','third_place_match','grand_final'
  ));


-- 2. helper: insert (or skip) a round + return its id ----------
create or replace function public._de_get_or_create_round(
  p_tournament_id uuid,
  p_round_number  integer,
  p_round_type    text,
  p_label         text
) returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
begin
  select id into v_id
    from public.tournament_rounds
   where tournament_id = p_tournament_id
     and round_type    = p_round_type
     and round_number  = p_round_number
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (p_tournament_id, p_round_number, p_label, p_round_type)
  returning id into v_id;
  return v_id;
end;
$$;

grant execute on function public._de_get_or_create_round(uuid, integer, text, text) to authenticated;


-- 3. main advancement trigger ---------------------------------
create or replace function public._advance_double_elim_bracket()
returns trigger language plpgsql security definer as $$
declare
  v_format          text;
  v_match_type      text;
  v_round_number    integer;
  v_round_type      text;
  v_uncompleted     integer;
  v_winner_count    integer;
  v_loser_count     integer;
  v_next_round_id   uuid;
  v_next_round_num  integer;
  v_next_label      text;
  v_pair_count      integer;
  v_i               integer;
  v_w1              record;
  v_w2              record;
  v_l1              record;
  v_l2              record;
  v_lb_target_num   integer;
  v_lb_existing     uuid;
  v_lb_pending      integer;   -- existing pending slots in target LB round
  v_wb_final_round  integer;
  v_lb_final_round  integer;
  v_wb_champ        record;
  v_lb_champ        record;
  v_gf_count        integer;
  v_gf_round_id     uuid;
  v_gf_winner_side  text;
begin
  -- Fire only on transitions into 'completed'.
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  begin
    -- Only double-elim tournaments.
    select format, match_type
      into v_format, v_match_type
      from public.tournaments
     where id = new.tournament_id;
    if v_format <> 'double_elimination' then
      return new;
    end if;
    v_match_type := coalesce(v_match_type, 'singles');

    -- Round metadata for the just-completed match.
    select round_number, round_type
      into v_round_number, v_round_type
      from public.tournament_rounds
     where id = new.round_id;
    if v_round_number is null then return new; end if;
    if v_round_type not in ('winners', 'losers', 'grand_final') then
      return new;
    end if;

    -- All sibling matches in this round must be complete.
    select count(*) into v_uncompleted
      from public.tournament_matches
     where round_id = new.round_id
       and status <> 'completed';
    if v_uncompleted > 0 then return new; end if;

    -- ────────────────────────────────────────────────────────
    --  GRAND FINAL branch
    -- ────────────────────────────────────────────────────────
    if v_round_type = 'grand_final' then
      -- GF rounds have exactly 1 match.
      if new.winner_team is null then return new; end if;

      if v_round_number = 1 then
        -- team1 = WB finalist, team2 = LB finalist (we set this when we
        -- created the round). If the LB finalist (team2) wins, bracket reset.
        if new.winner_team = 'team2' then
          -- Bracket reset: create GF2 with same pair, sides swapped is
          -- conventional but we keep team1=WB / team2=LB for simplicity.
          v_gf_round_id := public._de_get_or_create_round(
            new.tournament_id, 2, 'grand_final', 'Grand Final (Reset)');

          if not exists (
            select 1 from public.tournament_matches where round_id = v_gf_round_id
          ) then
            insert into public.tournament_matches (
              tournament_id, round_id, match_order, match_type,
              team1_player1, team1_player2,
              team2_player1, team2_player2,
              status
            ) values (
              new.tournament_id, v_gf_round_id, 0, v_match_type,
              new.team1_player1, new.team1_player2,
              new.team2_player1, new.team2_player2,
              'pending'
            );
          end if;
          return new;
        else
          -- WB finalist won → tournament complete.
          update public.tournaments
             set status = 'completed'
           where id = new.tournament_id
             and status <> 'completed';
          return new;
        end if;
      else
        -- GF2 always decides the champion.
        update public.tournaments
           set status = 'completed'
         where id = new.tournament_id
           and status <> 'completed';
        return new;
      end if;
    end if;

    -- Count winners + losers (only matches that actually played, i.e. have a
    -- decided winner; BYE rows shouldn't exist in DE since we don't insert
    -- half-formed matches).
    select count(*) filter (where winner_team in ('team1','team2')),
           count(*) filter (where winner_team in ('team1','team2'))
      into v_winner_count, v_loser_count
      from public.tournament_matches
     where round_id = new.round_id;
    -- (winner_count = loser_count = number of decisive matches in this round)

    -- ────────────────────────────────────────────────────────
    --  WINNERS-BRACKET branch
    -- ────────────────────────────────────────────────────────
    if v_round_type = 'winners' then
      -- (a) Drop losers from this WB round into the appropriate LB round.
      --     WB R1 losers → LB R1 paired
      --     WB R(X>=2) losers → LB R(2X-2) drop-in (vs LB R(2X-3) winners)
      if v_round_number = 1 then
        v_lb_target_num := 1;
        v_next_label    := 'Losers Round 1';

        v_next_round_id := public._de_get_or_create_round(
          new.tournament_id, v_lb_target_num, 'losers', v_next_label);

        -- Pair WB R1 losers with each other (loser(2i) vs loser(2i+1)).
        -- Only insert if the target LB round has no matches yet (idempotency).
        select count(*) into v_lb_pending
          from public.tournament_matches
         where round_id = v_next_round_id;

        if v_lb_pending = 0 then
          v_pair_count := v_loser_count / 2;
          for v_i in 0..(v_pair_count - 1) loop
            with ordered as (
              select tm.*,
                     row_number() over (order by match_order, id) - 1 as rn
                from public.tournament_matches tm
               where tm.round_id = new.round_id
                 and tm.winner_team in ('team1','team2')
            )
            select * into v_l1 from ordered where rn = v_i * 2;
            with ordered as (
              select tm.*,
                     row_number() over (order by match_order, id) - 1 as rn
                from public.tournament_matches tm
               where tm.round_id = new.round_id
                 and tm.winner_team in ('team1','team2')
            )
            select * into v_l2 from ordered where rn = v_i * 2 + 1;
            if v_l1 is null or v_l2 is null then continue; end if;

            insert into public.tournament_matches (
              tournament_id, round_id, match_order, match_type,
              team1_player1, team1_player2,
              team2_player1, team2_player2,
              status
            ) values (
              new.tournament_id, v_next_round_id, v_i, v_match_type,
              -- loser of v_l1
              case when v_l1.winner_team = 'team1' then v_l1.team2_player1 else v_l1.team1_player1 end,
              case when v_l1.winner_team = 'team1' then v_l1.team2_player2 else v_l1.team1_player2 end,
              -- loser of v_l2
              case when v_l2.winner_team = 'team1' then v_l2.team2_player1 else v_l2.team1_player1 end,
              case when v_l2.winner_team = 'team1' then v_l2.team2_player2 else v_l2.team1_player2 end,
              'pending'
            );
          end loop;

          -- Odd loser-count: the leftover gets a bye into LB R2 — we can't
          -- create that match yet because LB R1 winners aren't decided. The
          -- "drop-in" handler below will not see this guy though, so we
          -- stash by giving them a free win: insert a "completed" placeholder?
          -- Cleaner: simply skip and rely on WB R2 losers also being odd
          -- so they meet up later. For now, odd byes in LB are dropped — a
          -- documented limitation; brackets sized to powers of 2 don't hit
          -- this.
        end if;
      else
        -- WB R(X>=2) losers → LB R(2X-2) drop-in.
        v_lb_target_num := (v_round_number - 1) * 2;
        v_next_label    := format('Losers Round %s', v_lb_target_num);

        -- Need previous LB round (2X-3) to be complete before we can pair.
        -- If LB-prev isn't ready, skip — the LB-odd branch will create the
        -- drop-in once it completes (it checks for WB readiness symmetrically).
        if exists (
          select 1 from public.tournament_rounds
           where tournament_id = new.tournament_id
             and round_type    = 'losers'
             and round_number  = v_lb_target_num - 1
        ) and not exists (
          select 1 from public.tournament_matches tm
           join public.tournament_rounds tr on tr.id = tm.round_id
           where tr.tournament_id = new.tournament_id
             and tr.round_type    = 'losers'
             and tr.round_number  = v_lb_target_num - 1
             and tm.status        <> 'completed'
        ) then
          -- Bail if the target round + matches already exist.
          if exists (
            select 1 from public.tournament_matches tm
             join public.tournament_rounds tr on tr.id = tm.round_id
             where tr.tournament_id = new.tournament_id
               and tr.round_type    = 'losers'
               and tr.round_number  = v_lb_target_num
          ) then
            null;
          else
            v_next_round_id := public._de_get_or_create_round(
              new.tournament_id, v_lb_target_num, 'losers', v_next_label);

            -- Pair LB-prev winners (in order) vs WB losers (in order).
            v_pair_count := least(v_loser_count, (
              select count(*) from public.tournament_matches tm
               join public.tournament_rounds tr on tr.id = tm.round_id
               where tr.tournament_id = new.tournament_id
                 and tr.round_type    = 'losers'
                 and tr.round_number  = v_lb_target_num - 1
                 and tm.winner_team in ('team1','team2')
            ));
            for v_i in 0..(v_pair_count - 1) loop
              -- LB-prev winner #v_i
              with lb_prev as (
                select tm.*,
                       row_number() over (order by tm.match_order, tm.id) - 1 as rn
                  from public.tournament_matches tm
                  join public.tournament_rounds tr on tr.id = tm.round_id
                 where tr.tournament_id = new.tournament_id
                   and tr.round_type    = 'losers'
                   and tr.round_number  = v_lb_target_num - 1
                   and tm.winner_team in ('team1','team2')
              )
              select * into v_w1 from lb_prev where rn = v_i;

              -- WB-loser #v_i
              with wb_losers as (
                select tm.*,
                       row_number() over (order by tm.match_order, tm.id) - 1 as rn
                  from public.tournament_matches tm
                 where tm.round_id = new.round_id
                   and tm.winner_team in ('team1','team2')
              )
              select * into v_l1 from wb_losers where rn = v_i;
              if v_w1 is null or v_l1 is null then continue; end if;

              insert into public.tournament_matches (
                tournament_id, round_id, match_order, match_type,
                team1_player1, team1_player2,
                team2_player1, team2_player2,
                status
              ) values (
                new.tournament_id, v_next_round_id, v_i, v_match_type,
                -- LB-prev winner
                case when v_w1.winner_team = 'team1' then v_w1.team1_player1 else v_w1.team2_player1 end,
                case when v_w1.winner_team = 'team1' then v_w1.team1_player2 else v_w1.team2_player2 end,
                -- WB loser
                case when v_l1.winner_team = 'team1' then v_l1.team2_player1 else v_l1.team1_player1 end,
                case when v_l1.winner_team = 'team1' then v_l1.team2_player2 else v_l1.team1_player2 end,
                'pending'
              );
            end loop;
          end if;
        end if;
      end if;

      -- (b) WB advancement: pair winners into next WB round (same as single-elim).
      if v_winner_count >= 2 then
        v_next_round_num := v_round_number + 1;
        if not exists (
          select 1 from public.tournament_rounds
           where tournament_id = new.tournament_id
             and round_type    = 'winners'
             and round_number  = v_next_round_num
        ) then
          v_pair_count := v_winner_count / 2;
          v_next_label := format('Winners Round %s', v_next_round_num);
          v_next_round_id := public._de_get_or_create_round(
            new.tournament_id, v_next_round_num, 'winners', v_next_label);

          for v_i in 0..(v_pair_count - 1) loop
            with ordered as (
              select tm.*,
                     row_number() over (order by match_order, id) - 1 as rn
                from public.tournament_matches tm
               where tm.round_id = new.round_id
                 and tm.winner_team in ('team1','team2')
            )
            select * into v_w1 from ordered where rn = v_i * 2;
            with ordered as (
              select tm.*,
                     row_number() over (order by match_order, id) - 1 as rn
                from public.tournament_matches tm
               where tm.round_id = new.round_id
                 and tm.winner_team in ('team1','team2')
            )
            select * into v_w2 from ordered where rn = v_i * 2 + 1;
            if v_w1 is null or v_w2 is null then continue; end if;

            insert into public.tournament_matches (
              tournament_id, round_id, match_order, match_type,
              team1_player1, team1_player2,
              team2_player1, team2_player2,
              status
            ) values (
              new.tournament_id, v_next_round_id, v_i, v_match_type,
              case when v_w1.winner_team = 'team1' then v_w1.team1_player1 else v_w1.team2_player1 end,
              case when v_w1.winner_team = 'team1' then v_w1.team1_player2 else v_w1.team2_player2 end,
              case when v_w2.winner_team = 'team1' then v_w2.team1_player1 else v_w2.team2_player1 end,
              case when v_w2.winner_team = 'team1' then v_w2.team1_player2 else v_w2.team2_player2 end,
              'pending'
            );
          end loop;
        end if;
      end if;

      -- (c) WB final reached (1 winner) → check if LB final winner exists; if so, create GF.
      if v_winner_count = 1 then
        -- Find the LB final: it's the LB round with exactly 1 decisive match
        -- that produced a winner AND has no successor LB round.
        select tr.round_number into v_lb_final_round
          from public.tournament_rounds tr
         where tr.tournament_id = new.tournament_id
           and tr.round_type    = 'losers'
           and exists (
             select 1 from public.tournament_matches tm
              where tm.round_id = tr.id and tm.status = 'completed'
                and tm.winner_team in ('team1','team2')
           )
           and not exists (
             select 1 from public.tournament_rounds tr2
              where tr2.tournament_id = new.tournament_id
                and tr2.round_type    = 'losers'
                and tr2.round_number  > tr.round_number
           )
           and (
             select count(*) from public.tournament_matches tm
              where tm.round_id = tr.id and tm.winner_team in ('team1','team2')
           ) = 1
         limit 1;

        if v_lb_final_round is not null then
          perform public._de_create_grand_final(new.tournament_id, v_match_type);
        end if;
      end if;

      return new;
    end if;

    -- ────────────────────────────────────────────────────────
    --  LOSERS-BRACKET branch
    -- ────────────────────────────────────────────────────────
    if v_round_type = 'losers' then
      -- LB advancement. After an odd-numbered LB round (consolidation), winners
      -- proceed to the next drop-in round which needs WB losers — we DO NOT
      -- create that round here; the WB-loser handler will, once those WB
      -- matches complete. After an even-numbered LB round (drop-in), winners
      -- pair up into the next consolidation round.
      --
      -- LB R1 is special: its winners go to LB R2 (drop-in) which also needs
      -- WB R2 losers. We treat LB R1 like an odd round (winners wait for WB).

      if v_winner_count <= 1 then
        -- LB final: only one survivor → check if WB final winner exists; if
        -- so, create GF.
        if v_winner_count = 1 then
          select tr.round_number into v_wb_final_round
            from public.tournament_rounds tr
           where tr.tournament_id = new.tournament_id
             and tr.round_type    = 'winners'
             and (
               select count(*) from public.tournament_matches tm
                where tm.round_id = tr.id and tm.winner_team in ('team1','team2')
             ) = 1
           order by tr.round_number desc
           limit 1;

          if v_wb_final_round is not null then
            perform public._de_create_grand_final(new.tournament_id, v_match_type);
          end if;
        end if;
        return new;
      end if;

      -- More than one winner survives → continue LB.
      if (v_round_number % 2) = 1 then
        -- Odd LB round (consolidation or LB R1): winners wait for the next
        -- batch of WB losers; do NOT create the next LB round here. The
        -- WB-loser drop-in logic above will create it when ready.
        --
        -- Exception: if the corresponding WB round has ALREADY produced its
        -- losers, we should create the drop-in round now. That round's
        -- number is v_round_number + 1, drop-in WB-loser source is WB round
        -- ((v_round_number + 1) / 2) + 1.
        declare
          v_wb_src_round  integer := ((v_round_number + 1) / 2) + 1;
          v_target_lb_num integer := v_round_number + 1;
          v_wb_src_id     uuid;
          v_wb_loser_count integer;
        begin
          select id into v_wb_src_id
            from public.tournament_rounds
           where tournament_id = new.tournament_id
             and round_type    = 'winners'
             and round_number  = v_wb_src_round;
          if v_wb_src_id is null then return new; end if;

          select count(*) into v_wb_loser_count
            from public.tournament_matches
           where round_id = v_wb_src_id
             and status   = 'completed'
             and winner_team in ('team1','team2');

          select count(*) into v_uncompleted
            from public.tournament_matches
           where round_id = v_wb_src_id
             and status   <> 'completed';

          if v_uncompleted > 0 or v_wb_loser_count = 0 then return new; end if;

          -- Bail if matches already exist for the target round (round row
          -- alone may exist without matches; we only short-circuit on matches).
          if exists (
            select 1 from public.tournament_matches tm
             join public.tournament_rounds tr on tr.id = tm.round_id
             where tr.tournament_id = new.tournament_id
               and tr.round_type    = 'losers'
               and tr.round_number  = v_target_lb_num
          ) then return new; end if;

          v_next_round_id := public._de_get_or_create_round(
            new.tournament_id, v_target_lb_num, 'losers',
            format('Losers Round %s', v_target_lb_num));

          -- Pair LB-prev (this round) winners vs WB losers.
          v_pair_count := least(v_winner_count, v_wb_loser_count);
          for v_i in 0..(v_pair_count - 1) loop
            with lb_prev as (
              select tm.*,
                     row_number() over (order by tm.match_order, tm.id) - 1 as rn
                from public.tournament_matches tm
               where tm.round_id = new.round_id
                 and tm.winner_team in ('team1','team2')
            )
            select * into v_w1 from lb_prev where rn = v_i;

            with wb_losers as (
              select tm.*,
                     row_number() over (order by tm.match_order, tm.id) - 1 as rn
                from public.tournament_matches tm
               where tm.round_id = v_wb_src_id
                 and tm.winner_team in ('team1','team2')
            )
            select * into v_l1 from wb_losers where rn = v_i;
            if v_w1 is null or v_l1 is null then continue; end if;

            insert into public.tournament_matches (
              tournament_id, round_id, match_order, match_type,
              team1_player1, team1_player2,
              team2_player1, team2_player2,
              status
            ) values (
              new.tournament_id, v_next_round_id, v_i, v_match_type,
              case when v_w1.winner_team = 'team1' then v_w1.team1_player1 else v_w1.team2_player1 end,
              case when v_w1.winner_team = 'team1' then v_w1.team1_player2 else v_w1.team2_player2 end,
              case when v_l1.winner_team = 'team1' then v_l1.team2_player1 else v_l1.team1_player1 end,
              case when v_l1.winner_team = 'team1' then v_l1.team2_player2 else v_l1.team1_player2 end,
              'pending'
            );
          end loop;
        end;
      else
        -- Even LB round (drop-in): winners pair into the next consolidation
        -- round (an odd-numbered LB round).
        v_next_round_num := v_round_number + 1;
        if exists (
          select 1 from public.tournament_rounds
           where tournament_id = new.tournament_id
             and round_type    = 'losers'
             and round_number  = v_next_round_num
        ) then return new; end if;

        v_pair_count := v_winner_count / 2;
        if v_pair_count = 0 then
          -- Only 1 winner here → they ARE the LB finalist. Already handled
          -- above by the "v_winner_count <= 1" branch (we'd have returned).
          return new;
        end if;

        v_next_round_id := public._de_get_or_create_round(
          new.tournament_id, v_next_round_num, 'losers',
          format('Losers Round %s', v_next_round_num));

        for v_i in 0..(v_pair_count - 1) loop
          with ordered as (
            select tm.*,
                   row_number() over (order by match_order, id) - 1 as rn
              from public.tournament_matches tm
             where tm.round_id = new.round_id
               and tm.winner_team in ('team1','team2')
          )
          select * into v_w1 from ordered where rn = v_i * 2;
          with ordered as (
            select tm.*,
                   row_number() over (order by match_order, id) - 1 as rn
              from public.tournament_matches tm
             where tm.round_id = new.round_id
               and tm.winner_team in ('team1','team2')
          )
          select * into v_w2 from ordered where rn = v_i * 2 + 1;
          if v_w1 is null or v_w2 is null then continue; end if;

          insert into public.tournament_matches (
            tournament_id, round_id, match_order, match_type,
            team1_player1, team1_player2,
            team2_player1, team2_player2,
            status
          ) values (
            new.tournament_id, v_next_round_id, v_i, v_match_type,
            case when v_w1.winner_team = 'team1' then v_w1.team1_player1 else v_w1.team2_player1 end,
            case when v_w1.winner_team = 'team1' then v_w1.team1_player2 else v_w1.team2_player2 end,
            case when v_w2.winner_team = 'team1' then v_w2.team1_player1 else v_w2.team2_player1 end,
            case when v_w2.winner_team = 'team1' then v_w2.team1_player2 else v_w2.team2_player2 end,
            'pending'
          );
        end loop;
      end if;

      return new;
    end if;

  exception when others then
    -- Never block the score update.
    null;
  end;

  return new;
end;
$$;

grant execute on function public._advance_double_elim_bracket() to authenticated;


-- 4. helper: build the grand-final match once both finalists exist ---
create or replace function public._de_create_grand_final(
  p_tournament_id uuid,
  p_match_type    text
) returns void language plpgsql security definer as $$
declare
  v_wb_round_id   uuid;
  v_lb_round_id   uuid;
  v_wb_match      record;
  v_lb_match      record;
  v_wb_p1a uuid; v_wb_p1b uuid;
  v_lb_p1a uuid; v_lb_p1b uuid;
  v_gf_round_id   uuid;
begin
  -- WB final: the WB round with exactly 1 decisive match. (Could be more
  -- than one if a corner case leaves byes, but normal sizes hit 1.)
  select tr.id into v_wb_round_id
    from public.tournament_rounds tr
   where tr.tournament_id = p_tournament_id
     and tr.round_type    = 'winners'
     and (
       select count(*) from public.tournament_matches tm
        where tm.round_id = tr.id and tm.winner_team in ('team1','team2')
     ) = 1
   order by tr.round_number desc
   limit 1;
  if v_wb_round_id is null then return; end if;

  select * into v_wb_match
    from public.tournament_matches
   where round_id = v_wb_round_id
     and winner_team in ('team1','team2')
   limit 1;

  -- LB final: LB round that exists and has 1 decisive match and is the last LB round.
  select tr.id into v_lb_round_id
    from public.tournament_rounds tr
   where tr.tournament_id = p_tournament_id
     and tr.round_type    = 'losers'
     and (
       select count(*) from public.tournament_matches tm
        where tm.round_id = tr.id and tm.winner_team in ('team1','team2')
     ) = 1
     and not exists (
       select 1 from public.tournament_rounds tr2
        where tr2.tournament_id = p_tournament_id
          and tr2.round_type    = 'losers'
          and tr2.round_number  > tr.round_number
     )
   order by tr.round_number desc
   limit 1;
  if v_lb_round_id is null then return; end if;

  select * into v_lb_match
    from public.tournament_matches
   where round_id = v_lb_round_id
     and winner_team in ('team1','team2')
   limit 1;

  if exists (
    select 1 from public.tournament_rounds
     where tournament_id = p_tournament_id
       and round_type    = 'grand_final'
       and round_number  = 1
  ) then return; end if;

  v_gf_round_id := public._de_get_or_create_round(
    p_tournament_id, 1, 'grand_final', 'Grand Final');

  v_wb_p1a := case when v_wb_match.winner_team = 'team1' then v_wb_match.team1_player1 else v_wb_match.team2_player1 end;
  v_wb_p1b := case when v_wb_match.winner_team = 'team1' then v_wb_match.team1_player2 else v_wb_match.team2_player2 end;
  v_lb_p1a := case when v_lb_match.winner_team = 'team1' then v_lb_match.team1_player1 else v_lb_match.team2_player1 end;
  v_lb_p1b := case when v_lb_match.winner_team = 'team1' then v_lb_match.team1_player2 else v_lb_match.team2_player2 end;

  insert into public.tournament_matches (
    tournament_id, round_id, match_order, match_type,
    team1_player1, team1_player2,
    team2_player1, team2_player2,
    status
  ) values (
    p_tournament_id, v_gf_round_id, 0, p_match_type,
    v_wb_p1a, v_wb_p1b,  -- team1 = WB finalist (the "undefeated" side)
    v_lb_p1a, v_lb_p1b,  -- team2 = LB finalist
    'pending'
  );
end;
$$;

grant execute on function public._de_create_grand_final(uuid, text) to authenticated;


-- 5. wire up the trigger -------------------------------------
drop trigger if exists trg_advance_double_elim_bracket on public.tournament_matches;
create trigger trg_advance_double_elim_bracket
  after insert or update of status on public.tournament_matches
  for each row execute procedure public._advance_double_elim_bracket();


notify pgrst, 'reload schema';
