// The floating play island: elapsed time + court while a play session runs,
// with Enter score / Stay 1 more hour / End. Built on the foundation's
// LiveStatusIsland (every action bounded at 10 s, busy state always cleared).
//
// Also hosts the session's reconciliation with the server
// (useResumeLiveSession, 8 s bound) and the "starting now" notice sync, and
// expands when something asks to start a session while one already runs
// (openPlayStart -> playIslandExpand).
import React, { useEffect, useState } from 'react';
import { LiveStatusIsland, type IslandAction } from '@just-messin-around/expo-foundation/ui/island';
import { useResumeLiveSession } from '@just-messin-around/expo-foundation/session';
import { useElapsed, useSignal } from '@just-messin-around/expo-foundation/hooks';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useToast } from '../lib/useToast';
import { navigateWhenReady } from '../lib/navigationRef';
import {
  endPlay,
  getActivePlay,
  playIslandExpand,
  playSession,
  playStartUntracked,
  syncPlayStartReminders,
} from '../lib/playSession';
import {
  checkinChanged,
  extendCheckinByHour,
  peekCurrentCheckin,
  takeFixIfAllowed,
  type CurrentCheckin,
} from '../lib/courtCheckin';

function clock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export default function PlayIsland({ signedIn }: { signedIn: boolean }) {
  const toast = useToast();
  const s = playSession.useLiveSession();
  const elapsed = useElapsed(s.startedAtMs);
  const [checkin, setCheckin] = useState<CurrentCheckin | null>(null);
  const [expanded, setExpanded] = useState(false);

  useResumeLiveSession({ session: playSession, getActive: getActivePlay, timeoutMs: 8_000, enabled: signedIn });

  useEffect(() => {
    if (!signedIn) return;
    void syncPlayStartReminders();
    void peekCurrentCheckin().then(setCheckin);
  }, [signedIn]);
  useSignal(checkinChanged, setCheckin);
  useSignal(playIslandExpand, () => setExpanded(true));
  // A Start at a court that didn't check me in: the island stops naming the
  // court (lib/playSession) and says why, once.
  useSignal(playStartUntracked, ({ venueName }) => {
    toast.info(
      `Not checked in${venueName ? ` at ${venueName}` : ''}: you're not at the court, so only you see this session.`,
    );
  });

  const meta = s.meta;
  const active = signedIn && s.status !== 'idle' && !!meta;
  const where = meta?.venueName ?? checkin?.venueName ?? null;
  // The next session starts collapsed.
  useEffect(() => {
    if (!active) setExpanded(false);
  }, [active]);

  const actions: IslandAction[] = [
    {
      label: 'Enter score',
      onPress: () => navigateWhenReady('MatchEntry', { fromHome: true }),
    },
    ...(checkin && !checkin.queued
      ? [
          {
            label: 'Stay 1 more hour',
            variant: 'secondary' as const,
            onPress: async () => {
              try {
                // A fix (when location is allowed; no prompt here) keeps the
                // check-in confirmed; without one the server extends only so far.
                const fix = await takeFixIfAllowed(5_000);
                await extendCheckinByHour(checkin, fix);
                toast.success('Checked in for another hour.');
              } catch (e) {
                toast.error(friendlySbMessage(e, "Couldn't extend your check-in."));
              }
            },
          },
        ]
      : []),
    {
      label: 'End',
      variant: 'secondary',
      // Never waits on the network: clears now, the server write queues.
      onPress: () => {
        endPlay();
        toast.success('Session ended.');
      },
    },
  ];

  return (
    <LiveStatusIsland
      visible={active}
      expanded={active && expanded}
      onExpandedChange={setExpanded}
      // Bottom-anchored: the foundation (1.39+) lifts it to max(safe area,
      // bottom chrome slot) + gap, so it floats above a screen's
      // StickyActionBar (LeagueDetail, later TournamentDetail) instead of
      // covering it. Nothing to pass here; the bar publishes its own height.
      anchor="bottom"
      pill={{ primary: `${meta?.label ?? 'Playing'} · ${clock(elapsed)}`, secondary: where ?? undefined }}
      title="PLAYING NOW"
      stats={[
        { value: clock(elapsed), label: 'Elapsed' },
        ...(where ? [{ value: where, label: 'Court' }] : []),
      ]}
      actions={actions}
      accessibilityLabel="Play session in progress"
    />
  );
}
