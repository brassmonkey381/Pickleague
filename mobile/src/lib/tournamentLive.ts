/**
 * PKL-038: keep an open tournament screen live, with no pull-to-refresh.
 *
 * Two layers, both from the foundation:
 *   1. Supabase realtime (manageChannel, self-healing) on tournament_matches,
 *      tournament_rounds and tournaments for this one tournament. Any change
 *      reloads the screen after a short debounce.
 *   2. A light poll (usePollWhileActive) of a change signature: a few small
 *      columns of the same three tables. It reloads only when the signature
 *      moves. It runs every 5 s until realtime has delivered an event, then
 *      every 20 s as a safety net. This covers a project where those tables
 *      are not in the supabase_realtime publication (no migration in this
 *      repo adds them), so realtime alone may never fire.
 *
 * Everything stops when the screen loses focus or unmounts, and while the
 * app is in the background (the poll skips ticks; the channel is removed).
 * All three tables are readable by everyone under RLS (select using (true)).
 */
import { useEffect, useRef, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { manageChannel } from '@just-messin-around/expo-foundation/supabase';
import { usePollWhileActive } from '@just-messin-around/expo-foundation/hooks';
import { supabase } from './supabase';
import { tournamentSignature, type SigMatch } from './tournamentSignature';

/** Poll interval before realtime has proven itself, and after. */
export const LIVE_POLL_MS = 5_000;
export const LIVE_POLL_SAFETY_MS = 20_000;
/** Realtime bursts (a score plus its trigger-made rows) collapse into one reload. */
const DEBOUNCE_MS = 400;

async function fetchSignature(tournamentId: string): Promise<string | null> {
  const [m, r, t] = await Promise.all([
    supabase.from('tournament_matches')
      .select('id, status, winner_team, team1_score, team2_score, team1_player1, team1_player2, team2_player1, team2_player2')
      .eq('tournament_id', tournamentId),
    supabase.from('tournament_rounds').select('id').eq('tournament_id', tournamentId),
    supabase.from('tournaments').select('status').eq('id', tournamentId).maybeSingle(),
  ]);
  if (m.error || r.error || t.error) return null; // offline / flaky: try again next tick
  return tournamentSignature(
    (m.data ?? []) as SigMatch[],
    (r.data ?? []).map((x: { id: string }) => x.id),
    (t.data as { status: string } | null)?.status ?? null,
  );
}

/**
 * Call `onChange` within a few seconds of any change to this tournament while
 * the screen is focused and `enabled` (pass false for a tournament that can
 * no longer change, e.g. not yet drawn or already completed).
 */
export function useTournamentLive(
  tournamentId: string | null | undefined,
  enabled: boolean,
  onChange: () => void,
): void {
  const focused = useIsFocused();
  const active = !!tournamentId && enabled && focused;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [realtimeProven, setRealtimeProven] = useState(false);
  const lastSig = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fire = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onChangeRef.current();
    }, DEBOUNCE_MS);
  };

  // Layer 1: realtime.
  useEffect(() => {
    if (!active || !tournamentId) return;
    const onEvent = () => {
      setRealtimeProven(true);
      // The poll would see this same change next tick; re-baseline instead of
      // reloading twice.
      lastSig.current = null;
      fire();
    };
    const managed = manageChannel(supabase, `tournament-live-${tournamentId}`, ch => ch
      // Casts: supabase-js typings for realtime args are loose (as in useBadgeNotifications).
      .on('postgres_changes' as any, { event: '*', schema: 'public', table: 'tournament_matches', filter: `tournament_id=eq.${tournamentId}` }, onEvent)
      .on('postgres_changes' as any, { event: '*', schema: 'public', table: 'tournament_rounds', filter: `tournament_id=eq.${tournamentId}` }, onEvent)
      .on('postgres_changes' as any, { event: 'UPDATE', schema: 'public', table: 'tournaments', filter: `id=eq.${tournamentId}` }, onEvent));
    return () => {
      managed.stop();
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tournamentId]);

  // A refocus reloads the screen itself (useFocusEffect); start the poll from
  // a fresh baseline so that reload isn't repeated.
  useEffect(() => { if (!active) lastSig.current = null; }, [active]);

  // Layer 2: the signature poll.
  usePollWhileActive(async () => {
    if (!tournamentId) return;
    const sig = await fetchSignature(tournamentId);
    if (sig == null) return;
    const prev = lastSig.current;
    lastSig.current = sig;
    if (prev != null && prev !== sig) fire();
  }, realtimeProven ? LIVE_POLL_SAFETY_MS : LIVE_POLL_MS, active ? tournamentId! : null);
}
