// The floating play island: elapsed time + court while a play session runs,
// with Enter score / Stay 1 more hour / End. Built on the foundation's
// LiveStatusIsland (every action bounded at 10 s, busy state always cleared).
//
// Also hosts the session's reconciliation with the server
// (useResumeLiveSession, 8 s bound) and the "starting now" notice sync.
import React, { useEffect, useState } from 'react';
import { LiveStatusIsland, type IslandAction } from '@just-messin-around/expo-foundation/ui/island';
import { useResumeLiveSession } from '@just-messin-around/expo-foundation/session';
import { useElapsed, useSignal } from '@just-messin-around/expo-foundation/hooks';
import { useToast } from '../lib/useToast';
import { navigateWhenReady } from '../lib/navigationRef';
import { endPlay, getActivePlay, playSession, syncPlayStartReminders } from '../lib/playSession';
import { checkinChanged, extendCheckinByHour, peekCurrentCheckin, type CurrentCheckin } from '../lib/courtCheckin';

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

  useResumeLiveSession({ session: playSession, getActive: getActivePlay, timeoutMs: 8_000, enabled: signedIn });

  useEffect(() => {
    if (!signedIn) return;
    void syncPlayStartReminders();
    void peekCurrentCheckin().then(setCheckin);
  }, [signedIn]);
  useSignal(checkinChanged, setCheckin);

  const meta = s.meta;
  const active = signedIn && s.status !== 'idle' && !!meta;
  const where = meta?.venueName ?? checkin?.venueName ?? null;

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
                await extendCheckinByHour(checkin);
                toast.success('Checked in for another hour.');
              } catch {
                toast.error("Couldn't extend your check-in.");
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
