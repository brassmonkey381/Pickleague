-- Stop gating "your team needs to confirm" behind the match-RESULTS preference.
--
-- The bug: _notify_pending_match inserted its row with category = null, so
-- send-push fell back to TYPE_TO_PREF['match'] = 'notifyMatchResults'. Anyone
-- who muted match results therefore lost the confirm request too.
--
-- Those are not the same kind of message. A result is an FYI you can read
-- whenever. A confirm request is a time-boxed ACTION: the window is one hour,
-- and expire_pending_matches() (pg_cron, every minute) DELETES the row when it
-- lapses. Miss the push and a real match you played silently disappears, with
-- no trace left to explain it.
--
-- So it gets its own key, notifyMatchConfirms, defaulting to on. Users who want
-- to mute it still can — muting a category should mean something — but they now
-- have to say so deliberately rather than losing matches as a side effect of a
-- different choice.
--
-- ORDER-INDEPENDENT with the send-push deploy, deliberately. send-push only
-- honours a category listed in KNOWN_PREF_KEYS, so:
--   * this migration applied before the deploy → the key is unrecognised, falls
--     back to notifyMatchResults, i.e. exactly today's behaviour.
--   * the deploy landing before this migration → category stays null, same
--     fallback.
-- Neither half can break delivery on its own; the fix simply takes effect once
-- both are in.

create or replace function public._notify_pending_match()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_recipient uuid;
  v_entering  text;
  v_league    text;
  v_others    uuid[];
begin
  if new.status <> 'pending' then return new; end if;

  select full_name into v_entering from public.profiles
    where id = coalesce(new.team1_confirmed_by, new.team2_confirmed_by, new.player1_id);
  select name into v_league from public.leagues where id = new.league_id;

  v_others := array_remove(array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id],
                           coalesce(new.team1_confirmed_by, new.team2_confirmed_by));
  v_others := array_remove(v_others, null);

  foreach v_recipient in array v_others loop
    if v_recipient is null then continue; end if;
    if v_recipient = new.team1_confirmed_by or v_recipient = new.team2_confirmed_by then continue; end if;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read, category)
    values (
      v_recipient,
      '🥒 Match needs your team to confirm',
      format('%s entered a match in %s. Open match history to confirm within an hour.',
             coalesce(v_entering, 'A player'), coalesce(v_league, 'a league')),
      'match', new.id, 'match', false,
      'notifyMatchConfirms'
    );
  end loop;

  return new;
-- Unchanged and intentional: a failure here must never roll back the match
-- insert. A missed notification is recoverable; a lost match is not.
exception when others then
  return new;
end;
$function$;
