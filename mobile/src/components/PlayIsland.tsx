// The floating play island: elapsed time + court while a play session runs,
// with Enter score / Switch mode / Stay 1 more hour / Check out (= End: one
// tap ends the session and checks out; End when not checked in). Every
// check-in starts the session and a check-out ends it (lib/checkinPlay,
// imported here once). Built on the foundation's
// LiveStatusIsland (every action bounded at 10 s, busy state always cleared).
//
// Also hosts the session's reconciliation with the server
// (useResumeLiveSession, 8 s bound) and the "starting now" notice sync, and
// expands when something asks to start a session while one already runs
// (openPlayStart -> playIslandExpand).
import React, { useContext, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { PLAY_NAV_ENABLED } from '../lib/features';
import { setIslandShown, useNavBarHeight } from '../lib/appChrome';
import { islandBottom } from '../lib/navBarRules';
import CheckinPlanLine from './routines/CheckinPlanLine';
import IslandPillText from './play/IslandPillText';
import { LiveStatusIsland, type IslandAction } from '@just-messin-around/expo-foundation/ui/island';
import { useResumeLiveSession } from '@just-messin-around/expo-foundation/session';
import { useElapsed, useSignal } from '@just-messin-around/expo-foundation/hooks';
import { useToast } from '../lib/useToast';
import { openMatchEntryForSession } from '../lib/navigationRef';
// Every check-in starts the timer, a check-out ends it (side effects: once).
import { checkOutAndEnd } from '../lib/checkinPlay';
import { endActionLabel } from '../lib/checkinPlayRules';
import {
  getActivePlay,
  openPlayStart,
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
import { extendCheckinByHour, takeFixIfAllowed } from '../lib/courtCheckin';
import { useCurrentCheckin } from '../lib/useCurrentCheckin';

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
  // A change heard first wins over the cached read (lib/useCurrentCheckin).
  const [checkin] = useCurrentCheckin(signedIn);
  const [expanded, setExpanded] = useState(false);

  useResumeLiveSession({ session: playSession, getActive: getActivePlay, timeoutMs: 8_000, enabled: signedIn });

  useEffect(() => {
    if (!signedIn) return;
    void syncPlayStartReminders();
  }, [signedIn]);
  useSignal(playIslandExpand, () => setExpanded(true));
  // A Start at a court that didn't check me in: the island stops naming the
  // court (lib/playSession) and says why, once.
  useSignal(playStartUntracked, ({ venueName, reason, endedAtMs }) => {
    toast.info(untrackedStartNote(venueName, reason, { endedAtMs }));
  });
  // The session the island showed is over on the server without this
  // device's End (the 6-hour expiry, its check-in ending: run out, checked
  // out on the lock screen or elsewhere, an arrival at another court;
  // another device, or its Start never landed): say why. After the expiry or
  // a check-out, while its 2 hours to record are still running, the end
  // sheet asks for the match or drill that makes it count, as End would
  // have. Once they're over, the toast alone says it ended (nothing recorded
  // now could make it count).
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
  // With the bottom bar (PLAY_NAV_ENABLED): the island sits in the room the
  // navigator keeps clear just above the bar, so it never covers a screen's
  // content (lib/appChrome).
  const insets = useContext(SafeAreaInsetsContext);
  const barPx = useNavBarHeight();
  useEffect(() => {
    if (!PLAY_NAV_ENABLED) return;
    setIslandShown('play', active);
    return () => setIslandShown('play', false);
  }, [active]);
  const position = PLAY_NAV_ENABLED
    ? { bottom: islandBottom({ barPx, safeBottom: insets?.bottom ?? 0, gap: Platform.OS === 'web' ? 10 : 6 }) }
    : undefined;
  // The plan line for the session's check-in: how long, Closed group / Open
  // play, "Switch to open play now" and "Plan my play" (plan C2).
  const planCheckin = PLAY_NAV_ENABLED && checkin && !checkin.queued ? checkin : null;

  const actions: IslandAction[] = [
    {
      label: 'Enter score',
      timeoutMessage: STILL_WORKING,
      // Linked to this session: a match recorded from it makes it count. A
      // MatchEntry already open (from an event, say) keeps its form and gains the link.
      onPress: () => openMatchEntryForSession(s.id ?? undefined),
    },
    // Open play · Closed group · Drill, and how long: the ▶ Play sheet over
    // this session; its Start replaces it (the part played so far stays).
    ...(PLAY_NAV_ENABLED
      ? [
          {
            label: 'Switch mode',
            variant: 'secondary' as const,
            onPress: () => {
              setExpanded(false);
              const venueId = meta?.venueId ?? checkin?.venueId ?? null;
              const venueName = meta?.venueName ?? checkin?.venueName ?? null;
              openPlayStart({ switching: true, ...(venueId && venueName ? { venue: { id: venueId, name: venueName } } : {}) });
            },
          },
        ]
      : []),
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
    // (With the bar, the plan line below has this button, and Plan my play.)
    ...(ROUTINES_ENABLED && !PLAY_NAV_ENABLED && checkin && !checkin.queued
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
      // Check out = End (2026-10-24): one tap ends the session and checks out.
      label: endActionLabel(!!checkin),
      variant: 'secondary',
      timeoutMessage: STILL_WORKING,
      // The End never waits on the network: the island clears now, the server
      // write queues. The end sheet (play/PlayEndSheet) takes it from there:
      // "Record a match or drill?", or a note when the session was too short
      // or already counts. The check-out follows (its check-in hidden
      // meanwhile); one refused says why, and the check-in shows again.
      onPress: async () => {
        const { ended, checkedOut, venueName, error } = await checkOutAndEnd();
        if (error) {
          toast.error(explainRefusal(error, "Couldn't check you out. Try again.", { venueName }));
          return;
        }
        if (!ended) toast.success(checkedOut && venueName ? `Checked out of ${venueName}.` : 'Session ended.');
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
      style={position}
      // The mode and timer stay whole; only the court is cut short (IslandPillText).
      pill={<IslandPillText primary={`${meta?.label ?? 'Playing'} · ${clock(elapsed)}`} secondary={where} />}
      title="PLAYING NOW"
      stats={[
        { value: clock(elapsed), label: 'Elapsed' },
        ...(where ? [{ value: where, label: 'Court' }] : []),
      ]}
      sections={
        planCheckin
          ? [<CheckinPlanLine key="plan" checkinId={planCheckin.id} venueName={planCheckin.venueName} />]
          : undefined
      }
      actions={actions}
      accessibilityLabel="Play session in progress"
    />
  );
}
