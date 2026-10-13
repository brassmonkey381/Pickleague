// Joining a league: the open-league Join, the private-league "request a code",
// and redeeming an invite code. One hook so every surface that offers a Join
// (Play > Leagues, Home's JOIN A LEAGUE rows, the shared LeagueJoinCard on
// LeagueDetail / LeagueMembers) runs the same queries with the same copy.
//
// Extracted from LeaguesScreen (joinLeague / requestCode / joinWithCode) with
// the queries, error copy and success copy unchanged. Joining never touches the
// ratings / payout trigger cascade (a league_members upsert, a
// league_join_requests upsert, or the redeem_invite_code RPC), which is why it
// is the one data-changing action allowed inline on Home (plan decision 1).
//
// RLS (supabase/schema.sql + migration_rls_hardening_2026q3.sql):
//   - league_members insert: a user may add THEMSELVES as role 'member' to an
//     open league (private leagues go through a code or an admin).
//   - league_join_requests insert: user_id = auth.uid().
//   - redeem_invite_code: SECURITY DEFINER RPC granted to authenticated.
import { useCallback, useRef, useState } from 'react';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import type { UseStatusMessage } from '@just-messin-around/expo-foundation/hooks';
import { supabase } from './supabase';

/** Where join/request copy goes. A `useStatusMessage()` result fits as-is; Home
 *  can adapt a toast: `{ clear() {}, error: toast.error, success: toast.success }`. */
export type LeagueJoinStatusSink = Pick<UseStatusMessage, 'clear' | 'error' | 'success'>;

/** What redeem_invite_code reported for a code that worked. One code table
 *  serves leagues AND tournaments (migration_unified_invite_codes.sql). */
export type RedeemedInviteCode = {
  scopeType: 'league' | 'tournament' | string;
  scopeId: string | null;
  scopeName: string;
  message: string | null;
};

export type LeagueJoinedEvent =
  | { via: 'join'; leagueId: string }
  | ({ via: 'code' } & RedeemedInviteCode);

export type UseLeagueJoinOptions = {
  /** After a successful join or code redeem: reload the screen's data. Awaited
   *  while the league stays busy, so a row/card doesn't flash back to [Join]
   *  before the reload lands. A throw here is swallowed (the join succeeded). */
  onJoined?: (e: LeagueJoinedEvent) => void | Promise<unknown>;
  /** After a request was sent (e.g. reload so `hasRequested` comes back true).
   *  Not awaited: `requestedIds` already flips the UI to "Request sent". */
  onRequested?: (leagueId: string) => void | Promise<unknown>;
  /** Join / request copy goes here. Without it, errors land in `error` and the
   *  success copy in `notice`. Code-redeem errors ALWAYS land in `error` (they
   *  render inline in the code form), its success copy in the sink/`notice`. */
  status?: LeagueJoinStatusSink;
};

export type UseLeagueJoin = {
  /** Join an open league. Resolves true when the membership row was written. */
  join: (leagueId: string) => Promise<boolean>;
  /** Ask a private league's admins for a code. Resolves true when sent. */
  request: (leagueId: string, leagueName: string) => Promise<boolean>;
  /** Redeem an invite code (dashes/case/spaces ignored). The result on
   *  success (the caller closes its code form), null on any failure. */
  redeemCode: (code: string) => Promise<RedeemedInviteCode | null>;
  /** The league whose join/request is in flight (the latest one), else null. */
  busyId: string | null;
  /** Whether this league has a join/request in flight. */
  isBusy: (leagueId: string) => boolean;
  /** A code redeem is in flight. */
  joining: boolean;
  /** The code-redeem error (and join/request errors when no `status` sink). '' = none. */
  error: string;
  setError: (msg: string) => void;
  /** Success copy when no `status` sink was given. '' = none. */
  notice: string;
  /** Leagues joined / requested through THIS hook instance (optimistic UI until
   *  the caller's reload says the same). */
  joinedIds: ReadonlySet<string>;
  requestedIds: ReadonlySet<string>;
};

/** The request-sent copy, shared so every surface says the same thing. */
export function requestSentMessage(leagueName: string): string {
  return `Request sent. The admins of "${leagueName}" have been notified — they'll share an invite code with you.`;
}

/** Invite codes are shown as XXXX-XXXX; the RPC takes the bare uppercase token. */
export function normalizeInviteCode(code: string): string {
  return code.replace(/-/g, '').toUpperCase().trim();
}

/** Run a caller's reload callback now without awaiting it; a throw or a
 *  rejection is swallowed (the write it follows already succeeded). */
function fireAndForget(fn: () => void | Promise<unknown> | undefined): void {
  try {
    const p = fn();
    if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => {});
  } catch {
    // swallow
  }
}

export function useLeagueJoin(opts: UseLeagueJoinOptions = {}): UseLeagueJoin {
  // Latest callbacks without re-creating join/request every render.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [joinedIds, setJoinedIds] = useState<ReadonlySet<string>>(new Set());
  const [requestedIds, setRequestedIds] = useState<ReadonlySet<string>>(new Set());
  // Synchronous double-tap guard: state updates land a render late, so two
  // quick taps would otherwise both fire the upsert.
  const inFlight = useRef(new Set<string>());

  const clearCopy = () => {
    const sink = optsRef.current.status;
    if (sink) sink.clear();
    else { setError(''); setNotice(''); }
  };
  const fail = (msg: string) => {
    const sink = optsRef.current.status;
    if (sink) sink.error(msg);
    else setError(msg);
  };
  const succeed = (msg: string) => {
    const sink = optsRef.current.status;
    if (sink) sink.success(msg);
    else setNotice(msg);
  };

  const begin = (leagueId: string): boolean => {
    if (inFlight.current.has(leagueId)) return false;
    inFlight.current.add(leagueId);
    setBusyIds(new Set(inFlight.current));
    setBusyId(leagueId);
    return true;
  };
  const end = (leagueId: string) => {
    inFlight.current.delete(leagueId);
    setBusyIds(new Set(inFlight.current));
    setBusyId((cur) => (cur === leagueId ? null : cur));
  };

  const join = useCallback(async (leagueId: string): Promise<boolean> => {
    if (!begin(leagueId)) return false;
    clearCopy();
    try {
      try {
        const uid = await currentUserId(supabase);
        if (!uid) { fail('Please sign in again.'); return false; }
        await sbCall(() => supabase.from('league_members').upsert({ league_id: leagueId, user_id: uid, role: 'member' }));
      } catch (e) {
        fail(friendlySbMessage(e, "Couldn't join the league."));
        return false;
      }
      setJoinedIds((prev) => new Set(prev).add(leagueId));
      try { await optsRef.current.onJoined?.({ via: 'join', leagueId }); } catch { /* the join itself worked */ }
      return true;
    } finally {
      end(leagueId);
    }
  }, []);

  const request = useCallback(async (leagueId: string, leagueName: string): Promise<boolean> => {
    if (!begin(leagueId)) return false;
    clearCopy();
    try {
      const uid = await currentUserId(supabase);
      if (!uid) { fail('Please sign in again.'); return false; }
      await sbCall(() => supabase
        .from('league_join_requests')
        .upsert({ league_id: leagueId, user_id: uid, status: 'pending' }));
      setRequestedIds((prev) => new Set(prev).add(leagueId));
      // As LeaguesScreen did: kick off the reload (refreshes hasRequested),
      // then show the copy without waiting for it.
      fireAndForget(() => optsRef.current.onRequested?.(leagueId));
      succeed(requestSentMessage(leagueName));
      return true;
    } catch (e) {
      fail(friendlySbMessage(e, "Couldn't send the request."));
      return false;
    } finally {
      end(leagueId);
    }
  }, []);

  const redeemCode = useCallback(async (code: string): Promise<RedeemedInviteCode | null> => {
    setError('');
    const token = normalizeInviteCode(code);
    if (token.length < 8) { setError('Enter a valid invite code.'); return null; }

    setJoining(true);
    let data: unknown;
    try {
      const res = await supabase.rpc('redeem_invite_code', { p_token: token });
      if (res.error) { setError(res.error.message ?? 'Failed to redeem.'); return null; }
      data = res.data;
    } catch (e) {
      // supabase-js reports most failures in `error`; a thrown one (aborted
      // fetch) used to strand the "Joining..." label.
      setError(friendlySbMessage(e, 'Failed to redeem.'));
      return null;
    } finally {
      setJoining(false);
    }
    const row = (Array.isArray(data) ? data[0] : data) as
      | { success?: boolean; scope_type?: string; scope_id?: string | null; scope_name?: string; message?: string | null }
      | null
      | undefined;
    if (!row?.success) { setError(row?.message ?? 'Invalid invite code.'); return null; }

    const result: RedeemedInviteCode = {
      scopeType: row.scope_type ?? 'league',
      scopeId: row.scope_id ?? null,
      scopeName: row.scope_name ?? '',
      message: row.message ?? null,
    };
    if (result.scopeType !== 'tournament' && result.scopeId) {
      const id = result.scopeId;
      setJoinedIds((prev) => new Set(prev).add(id));
    }
    // Fire-and-forget like LeaguesScreen's loadLeagues() was: the code form
    // closes right away and the list catches up.
    fireAndForget(() => optsRef.current.onJoined?.({ via: 'code', ...result }));
    const heading = result.scopeType === 'tournament' ? 'Joined tournament!' : 'Joined!';
    succeed(`${heading} ${row.message ?? `You've joined "${row.scope_name}".`}`);
    return result;
  }, []);

  const isBusy = useCallback((leagueId: string) => busyIds.has(leagueId), [busyIds]);

  return {
    join, request, redeemCode,
    busyId, isBusy, joining,
    error, setError, notice,
    joinedIds, requestedIds,
  };
}
