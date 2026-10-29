#!/usr/bin/env node
// Before the court arrival files (and migration_hide_test_accounts.sql,
// migration_checkin_starts_session.sql, migration_auto_complete_seasons.sql)
// go live: are the live functions they replace still what the repo says they
// are? Each of those files rewrites a function from the last repo file that
// defined it (the live definitions could not be
// read when they were written), so a body changed on live by hand would be
// reverted without a word. This builds one read-only SQL file that compares
// each live body (pg_proc.prosrc) with
//   old  its definition in the file it was last applied from, and
//   new  its definition in the file that replaces it,
// ignoring whitespace and line endings only. Every function must match one of
// the two (old: not applied yet; new: applied already, so a second run of the
// apply script passes too). Anything else, or a function that is missing,
// raises "DRIFT: ..." and the query fails, so the apply stops before files
// 1-3. Merge the live definition into the court arrival file first:
//   select pg_get_functiondef('<signature>'::regprocedure);
//
//   node supabase/tests/check-replaced-functions.mjs [out.sql]
//   (from the linked checkout) supabase db query --linked -f <out.sql>
//
// Against live only: in the persona test the files are applied already, and
// A1 (court_arrival_personas.sql) checks the bodies there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const supa = path.resolve(here, '..');

// [signature, the file it was last applied from, the file that replaces it,
//  optionally a later file that replaced it again (null for none),
//  optionally the signature the replacing file gives it when it changes one:
//  then live is "old" with the old signature and body (and no new one), or
//  "new" with the new signature and body (and the old one gone)]
const REPLACED = [
  ['public._pl_checkin_arrival_fix()', 'migration_validity_rules.sql', 'migration_court_arrival_queue.sql'],
  ['public._pl_checkin_stay_from_fix()', 'migration_validity_rules.sql', 'migration_court_arrival_queue.sql'],
  ['public._pl_record_checkout_fix(uuid[],double precision,double precision,double precision,double precision)',
    'migration_validity_rules.sql', 'migration_court_arrival_queue.sql'],
  ['public._pl_session_validity(uuid)', 'migration_validity_rules.sql', 'migration_court_arrival_queue.sql'],
  ['public.expire_venue_checkins()', 'migration_venue_checkins.sql', 'migration_court_arrival_queue.sql'],
  // Replaced again later by migration_court_routines.sql (live since
  // 2026-10-22), so that body counts as a match too.
  // _purge_account: last applied from migration_court_routines.sql; the
  // signed-out audit fixes (migration_anon_audit_fixes.sql) replace it to
  // delete profile_private and stop setting the dropped profiles.phone.
  ['public._purge_account(uuid)', 'migration_court_routines.sql', 'migration_anon_audit_fixes.sql'],
  ['public.prune_presence_history()', 'migration_presence_p1_hygiene.sql', 'migration_court_arrival_queue.sql',
    'migration_court_routines.sql'],
  ['public.venue_set_geom()', 'migration_add_venue_geofences.sql', 'migration_court_arrival_settings.sql'],
  // Hide test accounts from discovery: these four gain the test-account filter.
  ['public.suggest_friends(integer)', 'migration_presence_p1_friends.sql', 'migration_hide_test_accounts.sql'],
  ['public.venue_players_here(text)', 'migration_presence_p1_reads.sql', 'migration_hide_test_accounts.sql'],
  ['public.court_presence(text)', 'migration_presence_p1_reads.sql', 'migration_hide_test_accounts.sql'],
  ['public._pl_venue_crowd(uuid,text)', 'migration_presence_p1_reads.sql', 'migration_hide_test_accounts.sql'],
  // Every check-in starts the play session (migration_checkin_starts_session.sql):
  // one line each in the arrival processor, the take-back (cancel and its
  // helper) and the two "open to play" reads, all last defined by
  // migration_court_routines.sql.
  ['public.process_court_arrivals()', 'migration_court_routines.sql', 'migration_checkin_starts_session.sql'],
  ['public.cancel_court_arrival(text,timestamptz,boolean)', 'migration_court_routines.sql',
    'migration_checkin_starts_session.sql'],
  ['public._pl_venue_open_now(uuid,text)', 'migration_court_routines.sql', 'migration_checkin_starts_session.sql'],
  ['public.court_play_modes(text)', 'migration_court_routines.sql', 'migration_checkin_starts_session.sql'],
  ['public._pl_take_back_arrival(uuid,uuid[],timestamptz)', 'migration_court_routines.sql',
    'migration_checkin_starts_session.sql'],
  // Seasons complete themselves (migration_auto_complete_seasons.sql): the
  // body moves into _complete_season_unchecked, complete_season keeps the
  // admin check (now null-safe for signed-out callers).
  ['public.complete_season(uuid)', 'migration_fix_complete_season_league_scoped.sql',
    'migration_auto_complete_seasons.sql'],
  // One-off planned check-ins and "Check in and tell friends"
  // (migration_court_oneoff_plans.sql): the arrival override counts routine
  // stops only, the reminder covers one-off plans, Undo skip / Change today's
  // time refuse a stop next to another plan there, and send_on_my_way gains
  // p_here (a fourth argument: the three-argument function is dropped).
  ['public._pl_court_arrival_off(uuid,text)', 'migration_court_routines.sql', 'migration_court_oneoff_plans.sql'],
  ['public.process_court_routine_reminders()', 'migration_court_routines.sql', 'migration_court_oneoff_plans.sql'],
  ['public.unskip_court_routine_occurrence(uuid)', 'migration_court_routines.sql', 'migration_court_oneoff_plans.sql'],
  ['public.move_court_routine_occurrence(uuid,timestamptz)', 'migration_court_routines.sql',
    'migration_court_oneoff_plans.sql'],
  ['public.send_on_my_way(text,integer,uuid[])', 'migration_on_my_way.sql', 'migration_court_oneoff_plans.sql', null,
    'public.send_on_my_way(text,integer,uuid[],boolean)'],
  // Plan sharing (migration_plan_sharing.sql): the owner's reads carry
  // shared_at / share_source, the routine settings auto_share_routines, an
  // edited routine keeps its stops' shares, and plan_court_checkin gains
  // p_share (a fourth argument: the three-argument function is dropped).
  // Needs migration_court_oneoff_plans.sql live first (list_my_court_plans).
  // ...and again by migration_plan_options.sql (adds length_min and windows),
  // so plan sharing's body is now the "old" one.
  ['public.list_my_court_plans()', 'migration_plan_sharing.sql', 'migration_plan_options.sql'],
  ['public.list_my_court_routines()', 'migration_court_routines.sql', 'migration_plan_sharing.sql'],
  ['public.get_court_routine_settings()', 'migration_court_routines.sql', 'migration_plan_sharing.sql'],
  ['public.save_court_routine(uuid,text,time,integer,text,integer,jsonb)', 'migration_court_routines_planned_end.sql',
    'migration_plan_sharing.sql'],
  // ...and a profile's weekly routines go to others only while auto-share is on.
  ['public.list_profile_court_routines(uuid)', 'migration_court_routines.sql', 'migration_plan_sharing.sql'],
  ['public.plan_court_checkin(text,timestamptz,integer)', 'migration_court_oneoff_plans.sql',
    'migration_plan_sharing.sql', null, 'public.plan_court_checkin(text,timestamptz,integer,boolean)'],
  // Signed-out audit fixes (migration_anon_audit_fixes.sql): the guest RPCs
  // write the phone to profile_private, generate_playoff_bracket gains its
  // admin check, get_wagers_on_player keeps closed leagues' bettors private.
  ['public.complete_guest_upgrade(text,text,text)', 'migration_guest_upgrade.sql', 'migration_anon_audit_fixes.sql'],
  ['public.redeem_guest_invite(text,text)', 'migration_guest_upgrade.sql', 'migration_anon_audit_fixes.sql'],
  ['public.generate_playoff_bracket(uuid)', 'migration_prod_reconcile_2026q3.sql', 'migration_anon_audit_fixes.sql'],
  ['public.get_wagers_on_player(uuid,text,uuid)', 'migration_prod_reconcile_2026q3.sql',
    'migration_anon_audit_fixes.sql'],
  // Match deletion takes back 150 per badge (what badges pay since 2026-05-25), not 50.
  ['public._reverse_match_side_effects()', 'migration_match_count_fix.sql', 'migration_fix_badge_reversal.sql'],
  // Signed-out audit, the rest (migration_anon_audit_rest.sql): the referral
  // code and inviter move to profile_private, so the three functions that
  // read or write them change table.
  ['public._pl_link_referral(uuid,text)', 'migration_referrals.sql', 'migration_anon_audit_rest.sql'],
  ['public.my_referral_code()', 'migration_referrals.sql', 'migration_anon_audit_rest.sql'],
  ['public.referral_preview(text)', 'migration_referrals.sql', 'migration_anon_audit_rest.sql'],
  // Equip only what you own (migration_cosmetic_equip_owned.sql): the profiles
  // column guard checks a changed equipped cosmetic against the player's items.
  ['public._pl_profiles_column_guard()', 'migration_profiles_column_guard.sql', 'migration_cosmetic_equip_owned.sql'],
  // ...and gift_shop_item refuses badge-gated items (they cost 0).
  ['public.gift_shop_item(uuid,uuid,text)', 'migration_gift_shop_item_notify.sql', 'migration_cosmetic_equip_owned.sql'],
  // Pickle economy guards (migration_pickle_economy_guards.sql): badges pay
  // once / competitions only with real play, the daily play cap, at most 5
  // games, no back-filled streaks, no pot house bonus.
  ['public._grant_pickles_on_badge()', 'migration_bump_base_pickle_grants.sql', 'migration_pickle_economy_guards.sql'],
  // ...and again by migration_fair_rewards.sql (front-loaded per day), so the
  // economy guards' body is now the "old" one.
  ['public._grant_match_game_bonus()', 'migration_pickle_economy_guards.sql', 'migration_fair_rewards.sql'],
  ['public._grant_daily_streak_bonus()', 'migration_local_day_boundaries.sql', 'migration_pickle_economy_guards.sql'],
  ['public._grant_tournament_participation_bonus()', 'migration_shop_rewards_and_progress_badges.sql', 'migration_pickle_economy_guards.sql'],
  ['public.contribute_pickles_to_pool(text,uuid,integer)', 'migration_add_pickle_pots.sql', 'migration_pickle_economy_guards.sql'],
  // Fair rewards (migration_fair_rewards.sql): Doggle's login build-up and
  // once-per-account streak badges; the daily cap counts the social earns.
  ['public.claim_daily_login_streak()', 'migration_local_day_boundaries.sql', 'migration_fair_rewards.sql'],
  ['public._pl_play_cap_left(uuid)', 'migration_pickle_economy_guards.sql', 'migration_fair_rewards.sql'],
  ['public._pl_profiles_play_cap()', 'migration_pickle_economy_guards.sql', 'migration_fair_rewards.sql'],
  // Plan options (migration_plan_options.sql): Drill joins Closed group and
  // Open play wherever windows are checked or worded.
  ['public._pl_windows_problem(jsonb,integer)', 'migration_court_routines.sql', 'migration_plan_options.sql'],
  ['public._pl_clean_abs_windows(uuid,jsonb,timestamptz,timestamptz)',
    'migration_court_routines.sql', 'migration_plan_options.sql'],
  ['public._pl_windows_summary(jsonb,timestamptz,text)', 'migration_court_routines.sql', 'migration_plan_options.sql'],
];
const TAG = '$pl_expect$';

function fail(msg) {
  console.error(`FAILED: ${msg}`);
  process.exit(1);
}

/** The body of the LAST definition of `name` in `file`: the text between its dollar quotes. */
function bodyOf(file, name) {
  const sql = fs.readFileSync(path.join(supa, file), 'utf8');
  // "create function" too: migration_validity_rules.sql drops and recreates
  // _pl_session_validity.
  const head = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+${name.replace(/\./g, '\\.')}\\s*\\(`, 'gi');
  let at = -1;
  for (const m of sql.matchAll(head)) at = m.index;
  if (at < 0) fail(`${file} has no "create [or replace] function ${name}(".`);
  const open = /\bas\s+(\$[A-Za-z_]*\$)/gi;
  open.lastIndex = at;
  const m = open.exec(sql);
  if (!m) fail(`${file}: no "as $...$" after ${name}.`);
  const start = m.index + m[0].length;
  const end = sql.indexOf(m[1], start);
  if (end < 0) fail(`${file}: ${name} has no closing ${m[1]}.`);
  return sql.slice(start, end);
}

// The same rule as the SQL below: runs of space, tab, CR, LF, FF or VT are
// one space, none at either end.
const norm = (s) => s.replace(/[ \t\r\n\f\v]+/g, ' ').replace(/^ | $/g, '');

const rows = REPLACED.map(([sig, oldFile, newFile, laterFile, newSig]) => {
  const name = sig.slice(0, sig.indexOf('('));
  const oldBody = norm(bodyOf(oldFile, name));
  const newBody = norm(bodyOf(newFile, name));
  if (oldBody === newBody) fail(`${name}: ${newFile} doesn't change ${oldFile}'s body; nothing to check.`);
  const laterBody = laterFile ? norm(bodyOf(laterFile, name)) : null;
  for (const b of [oldBody, newBody, laterBody ?? '']) if (b.includes(TAG) || b.includes('$pl_check$')) fail(`${name}: its body holds a quote tag.`);
  const later = laterBody === null ? 'null::text' : `${TAG}${laterBody}${TAG}`;
  const renamed = newSig ? `'${newSig}'` : 'null::text';
  return `    ('${sig}', '${oldFile}', '${newFile}', ${TAG}${oldBody}${TAG}, ${TAG}${newBody}${TAG}, ${later}, ${renamed})`;
});

const sql = `-- Generated by supabase/tests/check-replaced-functions.mjs (${new Date().toISOString()}).
-- Read-only: compares live function bodies with the repo files; raises DRIFT on a difference.
do $pl_check$
declare
  r     record;
  v_got text;
  v_old int := 0;
  v_new int := 0;
  v_later int := 0;
  v_bad text[] := '{}';
begin
  for r in
    select * from (values
${rows.join(',\n')}
    ) w(sig, src, dst, old_body, new_body, later_body, new_sig)
  loop
    -- A replacing file that changes the signature: applied when the new one
    -- is there (with its body) and the old one is gone.
    if r.new_sig is not null and to_regprocedure(r.new_sig) is not null then
      select regexp_replace(regexp_replace(p.prosrc, '[ \\t\\r\\n\\f\\v]+', ' ', 'g'), '^ | $', '', 'g')
        into v_got
        from pg_proc p where p.oid = to_regprocedure(r.new_sig);
      if v_got = r.new_body and to_regprocedure(r.sig) is null then
        v_new := v_new + 1;
      else
        v_bad := v_bad || (r.new_sig || ' differs from ' || r.dst || ' (or ' || r.sig || ' is still there)');
      end if;
      continue;
    end if;
    if to_regprocedure(r.sig) is null then
      v_bad := v_bad || (r.sig || ' is missing');
      continue;
    end if;
    select regexp_replace(regexp_replace(p.prosrc, '[ \\t\\r\\n\\f\\v]+', ' ', 'g'), '^ | $', '', 'g')
      into v_got
      from pg_proc p where p.oid = to_regprocedure(r.sig);
    if v_got = r.old_body then
      v_old := v_old + 1;
    elsif v_got = r.new_body then
      v_new := v_new + 1;
    elsif v_got = r.later_body then
      v_later := v_later + 1;
    else
      v_bad := v_bad || (r.sig || ' differs from ' || r.src || ' and from ' || r.dst);
    end if;
  end loop;
  if cardinality(v_bad) > 0 then
    raise exception using
      message = 'DRIFT: ' || array_to_string(v_bad, '; '),
      hint = 'Merge the live body (select pg_get_functiondef(''<signature>''::regprocedure)) into the file that replaces it, then run this again.';
  end if;
  raise notice 'replaced functions: % as in the repo files, % already the replacing versions, % replaced again by a later file', v_old, v_new, v_later;
end $pl_check$;
`;

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'pl_replaced_functions_check.sql'));
fs.writeFileSync(out, sql);
console.log(out);
