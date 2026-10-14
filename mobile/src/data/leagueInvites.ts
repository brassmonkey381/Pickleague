// Redeem a league invite code, for the push's Join button and its tap (the same
// auto-redeem the in-app Notifications list does).
//
// The one league-code redeem path: the push's Join button and tap
// (lib/push.ts, lib/notificationActions.ts) and the in-app Notifications list.
//
// Replay-safe: redeem_invite_code used to check max_uses BEFORE "already a
// member", so the second press of a single-use code (delivery is
// at-least-once) came back success=false "reached its max uses" although the
// first press joined. migration_league_join_resolution.sql moves the member
// check first; until that is verified live, a refusal still checks
// membership before calling it a failure.
import { sbCall, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';

export type LeagueInviteResult =
  | { joined: true; leagueId: string; leagueName: string | null; already: boolean }
  | { joined: false; message: string };

type RedeemRow = {
  success: boolean;
  scope_type: string;
  scope_id: string | null;
  scope_name: string;
  message: string;
};

const BOUND = { retries: 1, timeoutMs: 9_000 };

export async function redeemLeagueInvite(code: string): Promise<LeagueInviteResult> {
  // LOCAL session read, never getUser().
  const uid = await currentUserId(supabase);
  if (!uid) return { joined: false, message: 'Sign in to Pickleague to join.' };
  const data = await sbCall(() => supabase.rpc('redeem_invite_code', { p_token: code }), BOUND);
  const row = (Array.isArray(data) ? data[0] : data) as RedeemRow | null;
  if (row?.success && row.scope_id) {
    return {
      joined: true,
      leagueId: row.scope_id,
      leagueName: row.scope_name || null,
      already: /already a member/i.test(row.message ?? ''),
    };
  }
  if (row?.scope_type === 'league' && row.scope_id) {
    const member = await sbCall(
      () =>
        supabase
          .from('league_members')
          .select('user_id')
          .eq('league_id', row.scope_id as string)
          .eq('user_id', uid)
          .maybeSingle(),
      BOUND,
    );
    if (member) return { joined: true, leagueId: row.scope_id, leagueName: null, already: true };
  }
  return { joined: false, message: row?.message || "That invite code didn't work." };
}
