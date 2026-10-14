// Joining a league: the open-league Join, the private-league request (and its
// withdraw), and redeeming an invite code. One hook so every surface that
// offers a Join (Play > Leagues, Home's JOIN A LEAGUE rows, the shared
// LeagueJoinCard on LeagueDetail / LeagueMembers) runs the same queries with
// the same copy.
//
// Extracted from LeaguesScreen (joinLeague / requestCode / joinWithCode).
// Joining never touches the ratings / payout trigger cascade (a league_members
// upsert, the request_league_join / withdraw_league_join_request RPCs, or
// redeem_invite_code), which is why it is the one data-changing action allowed
// inline on Home (plan decision 1).
//
// RLS / RPCs (migration_rls_hardening_2026q3.sql,
// migration_league_join_resolution.sql):
//   - league_members insert: a user may add THEMSELVES as role 'member' to an
//     open league (private leagues go through a code or an admin).
//   - request_league_join / withdraw_league_join_request: SECURITY DEFINER
//     RPCs granted to authenticated. The request RPC answers member / joined /
//     pending / denied:<when> / sent (parsed in lib/leagueJoinResult.ts).
//   - redeem_invite_code: SECURITY DEFINER RPC granted to authenticated.
import { useCallback, useRef, useState } from 'react';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import type { UseStatusMessage } from '@just-messin-around/expo-foundation/hooks';
import { supabase } from './supabase';
import {
  isJoinedResult,
  isRequestOutstanding,
  parseRequestJoinResult,
  requestJoinCopy,
  type RequestJoinResult,
} from './leagueJoinResult';

export { requestSentMessage } from './leagueJoinResult';

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
  /** After a request was withdrawn (reload so `hasRequested` comes back false).
   *  Not awaited: `withdrawnIds` already flips the UI back to [Request]. */
  onWithdrawn?: (leagueId: string) => void | Promise<unknown>;
  /** Join / request copy goes here. Without it, errors land in `error` and the
   *  success copy in `notice`. Code-redeem errors ALWAYS land in `error` (they
   *  render inline in the code form), its success copy in the sink/`notice`. */
  status?: LeagueJoinStatusSink;
};

export type UseLeagueJoin = {
  /** Join an open league. Resolves true when the membership row was written. */
  join: (leagueId: string) => Promise<boolean>;
  /** Ask a private league's admins to let me in. Resolves true when a request
   *  is with the admins (new or already there) or the league let me in. */
  request: (leagueId: string, leagueName: string) => Promise<boolean>;
  /** Take back my pending request. Resolves true when it is gone. */
  withdraw: (leagueId: string) => Promise<boolean>;
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
  /** Leagues joined / requested / withdrawn through THIS hook instance
   *  (optimistic UI until the caller's reload says the same). */
  joinedIds: ReadonlySet<string>;
  requestedIds: ReadonlySet<string>;
  withdrawnIds: ReadonlySet<string>;
  /** The viewer has an outstanding request to this league: this instance's
   *  request / withdraw overrides what the server last said (`serverSays`). */
  isRequested: (leagueId: string, serverSays: boolean | undefined) => boolean;
};

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

function without(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
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
  const [withdrawnIds, setWithdrawnIds] = useState<ReadonlySet<string>>(new Set());
  // Synchronous double-tap guard: state updates land a render late, so two
  // quick taps would otherwise both fire the write.
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
        // On (league_id, user_id), not the id PK: a second tap or device that
        // is already in the league is a no-op instead of a 23505.
        await sbCall(() => supabase
          .from('league_members')
          .upsert(
            { league_id: leagueId, user_id: uid, role: 'member' },
            { onConflict: 'league_id,user_id', ignoreDuplicates: true },
          ));
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
      let result: RequestJoinResult | null;
      try {
        const raw = await sbCall(() => supabase.rpc('request_league_join', { p_league_id: leagueId }));
        result = parseRequestJoinResult(raw);
      } catch (e) {
        fail(friendlySbMessage(e, "Couldn't send the request."));
        return false;
      }
      if (!result) { fail("Couldn't send the request."); return false; }

      const copy = requestJoinCopy(result, leagueName);
      if (isJoinedResult(result)) {
        // The league has since opened (or I was already in): a join.
        setJoinedIds((prev) => new Set(prev).add(leagueId));
        try { await optsRef.current.onJoined?.({ via: 'join', leagueId }); } catch { /* the join itself worked */ }
        succeed(copy.message);
        return true;
      }
      if (isRequestOutstanding(result)) {
        setRequestedIds((prev) => new Set(prev).add(leagueId));
        setWithdrawnIds((prev) => without(prev, leagueId));
        // As LeaguesScreen did: kick off the reload (refreshes hasRequested),
        // then show the copy without waiting for it.
        fireAndForget(() => optsRef.current.onRequested?.(leagueId));
        succeed(copy.message);
        return true;
      }
      fail(copy.message); // denied, inside the cooldown
      return false;
    } finally {
      end(leagueId);
    }
  }, []);

  const withdraw = useCallback(async (leagueId: string): Promise<boolean> => {
    if (!begin(leagueId)) return false;
    clearCopy();
    try {
      // 'withdrawn', or 'none' when nothing was pending: either way no request.
      await sbCall(() => supabase.rpc('withdraw_league_join_request', { p_league_id: leagueId }));
      setWithdrawnIds((prev) => new Set(prev).add(leagueId));
      setRequestedIds((prev) => without(prev, leagueId));
      fireAndForget(() => optsRef.current.onWithdrawn?.(leagueId));
      succeed('Request withdrawn.');
      return true;
    } catch (e) {
      fail(friendlySbMessage(e, "Couldn't withdraw the request."));
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
  const isRequested = useCallback(
    (leagueId: string, serverSays: boolean | undefined) =>
      requestedIds.has(leagueId) || (!!serverSays && !withdrawnIds.has(leagueId)),
    [requestedIds, withdrawnIds],
  );

  return {
    join, request, withdraw, redeemCode,
    busyId, isBusy, joining,
    error, setError, notice,
    joinedIds, requestedIds, withdrawnIds, isRequested,
  };
}
