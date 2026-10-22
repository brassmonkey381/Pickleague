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
import { useToast } from '../lib/useToast';
import { openMatchEntryForSession } from '../lib/navigationRef';
import {
  endPlay,
  getActivePlay,
  playEnded,
  playIslandExpand,
  playLost,
  playSession,
  playStartUntracked,
  syncPlayStartReminders,
} from '../lib/playSession';
import { explainRefusal } from '../lib/refusalNotices';
import { ROUTINES_ENABLED } from '../lib/features';
import { switchToOpenPlan } from '../lib/courtRoutineRules';
import { getCheckinPlan, setCheckinPlan } from '../data/courtRoutines';
import { STILL_WORKING, untrackedStartNote } from '../lib/refusals';
import { lostPlayNote, lostPlayOffersRecord } from '../lib/sessionValidity';
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
  useSignal(playStartUntracked, ({ venueName, reason, endedAtMs }) => {
    toast.info(untrackedStartNote(venueName, reason, { endedAtMs }));
  });
  // The session the island showed is over on the server without this
  // device's End (the 6-hour expiry, another device, or its Start never
  // landed): say why. After the expiry, while its 2 hours to record are still
  // running, the end sheet asks for the match or drill that makes it count,
  // as End would have. Once they're over, the toast alone says it ended
  // (nothing recorded now could make it count).
  useSignal(playLost, (lost) => {
    toast.info(lostPlayNote(lost));
    if (lostPlayOffersRecord(lost) && lost.endedAtMs != null) {
      playEnded.emit({
        id: lost.id,
        kind: lost.kind,
        sourceId: lost.sourceId,
        startedAtMs: lost.startedAtMs,
        endedAtMs: lost.endedAtMs,
        recorded: lost.recorded,
      });
    }
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
      timeoutMessage: STILL_WORKING,
      // Linked to this session: a match recorded from it makes it count. A
      // MatchEntry already open (from an event, say) keeps its form and gains the link.
      onPress: () => openMatchEntryForSession(s.id ?? undefined),
    },
    ...(checkin && !checkin.queued
      ? [
          {
            label: 'Stay 1 more hour',
            variant: 'secondary' as const,
            timeoutMessage: STILL_WORKING,
            onPress: async () => {
              try {
                // A fix (when location is allowed; no prompt here) keeps the
                // check-in confirmed; without one the server extends only so far.
                const fix = await takeFixIfAllowed(5_000);
                const { note } = await extendCheckinByHour(checkin, fix);
                // The full hour, or less and why.
                if (note.full) toast.success(note.message);
                else toast.info(note.message);
              } catch (e) {
                // Why, in words: how far from the court, no fix for 4 hours,
                // the check-in already ended (lib/refusals).
                toast.error(
                  explainRefusal(e, "Couldn't extend your check-in. Try again.", {
                    venueName: checkin.venueName,
                    action: 'extend',
                  }),
                );
              }
            },
          },
        ]
      : []),
    // Routines: the rest of this window becomes open play (set_checkin_plan).
    ...(ROUTINES_ENABLED && checkin && !checkin.queued
      ? [
          {
            label: 'Switch to open play now',
            variant: 'secondary' as const,
            timeoutMessage: STILL_WORKING,
            onPress: async () => {
              try {
                const plan = await getCheckinPlan(checkin.id);
                const next = plan ? switchToOpenPlan(plan, new Date()) : null;
                if (!plan || !next) {
                  toast.info("You're already open to play.");
                  return;
                }
                await setCheckinPlan(checkin.id, next.plannedEnd, next.windows);
                toast.success("You're open to play. Others here see it.");
              } catch (e) {
                toast.error(
                  explainRefusal(e, "Couldn't switch to open play. Try again.", {
                    venueName: checkin.venueName,
                    action: 'plan',
                  }),
                );
              }
            },
          },
        ]
      : []),
    {
      label: 'End',
      variant: 'secondary',
      timeoutMessage: STILL_WORKING,
      // Never waits on the network: clears now, the server write queues. The
      // end sheet (play/PlayEndSheet) takes it from there: "Record a match or
      // drill?", or a note when the session was too short or already counts.
      onPress: () => {
        if (!endPlay()) toast.success('Session ended.');
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
