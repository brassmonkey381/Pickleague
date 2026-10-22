// God mode: test accounts and the app-wide "hide them from discovery" switch
// (supabase/migration_hide_test_accounts.sql). Admin-only RPCs: anyone else is
// refused server-side with a readable message (hint 'pl:admin.only'), so the
// UI hides these controls from non-admins but never relies on that.
//
// The filtering itself happens on the server (discover_players, suggest_friends,
// court_presence, venue_players_here, venue_crowd); the app never decides who
// is visible. Every function here THROWS on failure so the caller can say what
// went wrong instead of showing a stale switch.

import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';

/** Whether test accounts are hidden from ordinary players' discovery. */
export async function getHideTestAccounts(): Promise<boolean> {
  return (await sbCall(() => supabase.rpc('get_hide_test_accounts'))) === true;
}

/** Turns the app-wide switch on or off. Returns the new value. */
export async function setHideTestAccounts(on: boolean): Promise<boolean> {
  return (await sbCall(() => supabase.rpc('set_hide_test_accounts', { p_on: on }))) === true;
}

/** Whether one account is marked as a test account. */
export async function getProfileTestAccount(profileId: string): Promise<boolean> {
  return (await sbCall(() => supabase.rpc('get_profile_test_account', { p_profile: profileId }))) === true;
}

/** Marks or unmarks one account as a test account. Returns the new value. */
export async function setProfileTestAccount(profileId: string, on: boolean): Promise<boolean> {
  return (await sbCall(() =>
    supabase.rpc('set_profile_test_account', { p_profile: profileId, p_on: on }),
  )) === true;
}
