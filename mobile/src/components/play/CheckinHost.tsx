// The one owner of the check-in flow at the app root (PLAY_NAV_ENABLED, plan
// C1), mounted next to PlayIsland. It holds lib/useCourtCheckIn and the
// listeners Home's court card used to own (a queued check-in refused later,
// a check-in that ended without a Check out, the one-time star offer), and
// drives the island while no play session runs:
//
//   idle ........ nothing shows
//   finding ..... "Finding your court…" / "Checking you in…"
//   prompt ...... "AT RIVERSIDE?"  [Check in] [Not here]   (a 'home/' push)
//   checked in .. "CHECKED IN · Riverside · until 12 PM"
//                 [▶ Start playing] [Stay 1 more hour] [Check out], the plan line
//   note ........ why a check-in didn't happen, with Pick a court / Add this
//                 court / Start without a court
//
// The bar's centre Check in (checkinHereRequested) is Doggle's one tap: a
// fresh fix, the court within 150 m, checked in there for 2 hours (or to the
// end of a routine stop due there). It asks, with the court picker, only when
// it can't tell. While a session runs PlayIsland shows instead (a session at
// a court is its check-in), and Check in expands that island.
//
// Home's CourtCheckinCard still renders for now; it leaves the once-only
// notes to this host (lib/checkinHost checkinHostOwnsNotes), so nothing is
// said twice.
import React, { useCallback, useContext, useEffect, useState } from 'react';
import { AppState, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { BottomSheet } from '@just-messin-around/expo-foundation/ui';
import { LiveStatusIsland, type IslandAction } from '@just-messin-around/expo-foundation/ui/island';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../../lib/supabase';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { navigateWhenReady, navigationRef } from '../../lib/navigationRef';
import { navRouteChanged } from '../../navigation/AppNavBar';
import {
  checkinChanged,
  checkinRejected,
  checkOut,
  extendCheckinByHour,
  peekCurrentCheckin,
  refreshCurrentCheckin,
  takeCheckinFix,
  takeEndedCheckinNote,
  takeFixIfAllowed,
  takeRejectedCheckinNotice,
  type CurrentCheckin,
} from '../../lib/courtCheckin';
import { CHECKOUT_FIX_WAIT_MS, FIX_REUSE_MS, isFixFresh } from '../../lib/courtCheckinRules';
import { clockLabel } from '../../lib/courtRoutineRules';
import { CHECKIN_BOUND_MS, CHECKIN_BOUND_MS_DEFAULT, useCourtCheckIn } from '../../lib/useCourtCheckIn';
import { openPlayStart, playIslandExpand, playSession, startPlay } from '../../lib/playSession';
import {
  checkinAtRequested,
  checkinHereRequested,
  checkinHostBusy,
  checkinIslandExpand,
  setCheckinHostMounted,
  takeCheckinIslandRequest,
} from '../../lib/checkinHost';
import { setIslandShown, useNavBarHeight } from '../../lib/appChrome';
import { islandBottom } from '../../lib/navBarRules';
import { mergeCourtCandidates, courtNote, type CourtCandidate, type CourtReason } from '../../lib/playStartCourts';
import { track } from '../../lib/analytics';
import {
  getMyLeagueCourts,
  getMyRecentCourts,
  getVenuesByIds,
  resolveCourtAt,
  type ResolvedCourt,
} from '../../data/venueCheckins';
import { listMyCourtFavorites } from '../../data/courtFavorites';
import { PLAY_NAV_ENABLED } from '../../lib/features';
import CourtCheckInNotes from '../court/CourtCheckInNotes';
import CheckinPlanLine from '../routines/CheckinPlanLine';

const CHECKOUT_BOUND_MS = CHECKIN_BOUND_MS_DEFAULT + CHECKOUT_FIX_WAIT_MS;
const GAP = Platform.OS === 'web' ? 10 : 6;

export default function CheckinHost({ signedIn }: { signedIn: boolean }) {
  if (!PLAY_NAV_ENABLED || !signedIn) return null;
  return <Host />;
}

function Host() {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const insets = useContext(SafeAreaInsetsContext);
  const barPx = useNavBarHeight();
  const [current, setCurrent] = useState<CurrentCheckin | null>(null);
  // A court found by a push's look-up: "At X?" with Check in / Not here.
  const [nearby, setNearby] = useState<ResolvedCourt | null>(null);
  const [addAt, setAddAt] = useState<{ lat: number; lng: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [picking, setPicking] = useState(false);
  const flow = useCourtCheckIn({
    onCheckedIn: (next) => {
      setCurrent(next);
      setNearby(null);
      setAddAt(null);
      setExpanded(true);
    },
    onCurrent: setCurrent,
  });
  const { busy, message, setMessage, offerUntracked, setOfferUntracked, starOffer, alertsResult, run, noFix, lastFix } = flow;
  const playing = playSession.useLiveSession().status !== 'idle';

  useEffect(() => {
    setCheckinHostMounted(true);
    return () => setCheckinHostMounted(false);
  }, []);
  useEffect(() => {
    checkinHostBusy.emit(busy);
  }, [busy]);

  // My check-in, from the cache at once and the server on mount and on every
  // return to the foreground. The once-only notes are said here (and on any
  // screen, unlike Home's card).
  const sync = useCallback(() => {
    refreshCurrentCheckin()
      .then(async (cur) => {
        setCurrent(cur);
        const ended = await takeEndedCheckinNote();
        if (ended && !cur) {
          setMessage(ended);
          setExpanded(true);
        }
      })
      .catch(() => {});
    void takeRejectedCheckinNotice().then((notice) => {
      if (!notice) return;
      setMessage(notice);
      setExpanded(true);
    });
  }, [setMessage]);
  useEffect(() => {
    void peekCurrentCheckin().then(setCurrent);
    sync();
    const off = checkinChanged.subscribe(setCurrent);
    const app = AppState.addEventListener('change', (s) => {
      if (s === 'active') sync();
    });
    return () => {
      off();
      app.remove();
    };
  }, [sync]);
  useSignal(checkinRejected, () => {
    void takeRejectedCheckinNotice().then((notice) => {
      if (!notice) return;
      setMessage(notice);
      setExpanded(true);
    });
  });

  /**
   * The court I'm at, from a fresh fix within 150 m. `interactive`: the bar's
   * tap (asks for location, says why when there's no fix or no court);
   * otherwise a push's look-up (never prompts, silent when it can't tell).
   */
  const findHere = useCallback(
    async (interactive: boolean): Promise<ResolvedCourt | null> => {
      // A push's look-up stays silent: no "Finding…" island, no error note.
      if (!interactive) {
        try {
          const fix = await takeFixIfAllowed(6_000);
          if (!fix) return null;
          lastFix.current = fix;
          return await resolveCourtAt(fix.lat, fix.lng, 150);
        } catch {
          return null;
        }
      }
      let found: ResolvedCourt | null = null;
      await run(
        'find',
        async () => {
          setAddAt(null);
          const fix = interactive ? await takeCheckinFix(6_000) : await takeFixIfAllowed(6_000);
          if (!fix) {
            if (interactive) await noFix();
            return;
          }
          lastFix.current = fix;
          found = await resolveCourtAt(fix.lat, fix.lng, 150);
          if (!found && interactive) {
            setMessage('No court found within 150 m of you.');
            setAddAt({ lat: fix.lat, lng: fix.lng });
          }
        },
        "Couldn't look up nearby courts. Try again.",
        { askLocation: interactive, boundMs: CHECKIN_BOUND_MS },
      );
      return found;
    },
    [run, noFix, lastFix, setMessage],
  );

  // The bar's centre button.
  useSignal(checkinHereRequested, () => {
    if (playSession.get().status !== 'idle') {
      playIslandExpand.emit();
      return;
    }
    if (busy) return;
    if (current) {
      setExpanded((x) => !x);
      return;
    }
    setNearby(null);
    setExpanded(true);
    void (async () => {
      const found = await findHere(true);
      track('checkin.tap', { result: found ? 'court' : 'none' });
      if (found) await flow.checkIn({ id: found.id, name: found.name });
    })();
  });
  // "Just check in" at a court the player named.
  useSignal(checkinAtRequested, (v) => {
    if (busy) return;
    setNearby(null);
    setExpanded(true);
    void flow.checkIn(v);
  });
  // A 'home/' push (the check-in reminder, the arrival notice), live or from
  // before this mounted (a cold start).
  const showIsland = async () => {
    if (playSession.get().status !== 'idle') {
      playIslandExpand.emit();
      return;
    }
    if (await peekCurrentCheckin()) {
      setExpanded(true);
      return;
    }
    const found = await findHere(false);
    if (found) {
      setNearby(found);
      setExpanded(true);
    }
  };
  useSignal(checkinIslandExpand, () => {
    if (takeCheckinIslandRequest()) void showIsland();
  });
  useEffect(() => {
    if (takeCheckinIslandRequest()) void showIsland();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  const extend = (cur: CurrentCheckin) =>
    run(
      'extend',
      async () => {
        const fix = isFixFresh(lastFix.current, Date.now(), FIX_REUSE_MS) ? lastFix.current : await takeFixIfAllowed(6_000);
        if (fix) lastFix.current = fix;
        const { next, note } = await extendCheckinByHour(cur, fix);
        if (next) setCurrent(next);
        if (note.full) toast.success(note.message);
        else setMessage(note.message);
      },
      "Couldn't extend your check-in. Try again.",
      { boundMs: CHECKIN_BOUND_MS, refusal: { venueName: cur.venueName, action: 'extend' } },
    );

  const out = (cur: CurrentCheckin) =>
    run(
      'out',
      async () => {
        await checkOut(cur.id);
        setCurrent(null);
        setExpanded(false);
        toast.success(`Checked out of ${cur.venueName}.`);
      },
      "Couldn't check you out. Try again.",
      { boundMs: CHECKOUT_BOUND_MS, refusal: { venueName: cur.venueName } },
    );

  const startUntracked = () => {
    setMessage(null);
    setOfferUntracked(false);
    startPlay({ kind: 'open_play', sourceId: null, venueId: null, venueName: null });
  };

  const clearNotes = () => {
    setMessage(null);
    setOfferUntracked(false);
    setAddAt(null);
    setNearby(null);
    setExpanded(false);
  };

  const noted = !!message || !!starOffer || !!alertsResult || offerUntracked || !!addAt;
  const finding = busy === 'find' || busy === 'checkin';
  // Home's court card already shows my check-in: there the island shows only
  // when asked (the centre button, a push) or with something to say, and
  // keeps no room clear under Home for it.
  const [onHome, setOnHome] = useState(false);
  const readRoute = () => setOnHome(navigationRef.isReady() && navigationRef.getCurrentRoute()?.name === 'Home');
  useEffect(readRoute, []);
  useSignal(navRouteChanged, readRoute);
  const quietOnHome = onHome && !expanded && !nearby && !finding && !noted;
  const visible = !playing && (!!current || !!nearby || finding || noted) && !quietOnHome;
  useEffect(() => {
    setIslandShown('checkin', visible);
    return () => setIslandShown('checkin', false);
  }, [visible]);
  useEffect(() => {
    if (!visible) setExpanded(false);
  }, [visible]);

  const safeBottom = insets?.bottom ?? 0;
  const position = { bottom: islandBottom({ barPx, safeBottom, gap: GAP }) };

  let pill: { primary: string; secondary?: string };
  let title: string;
  let actions: IslandAction[] = [];
  const sections: React.ReactNode[] = [];

  if (current) {
    const until = clockLabel(current.expiresAt);
    pill = { primary: 'CHECKED IN', secondary: `${current.venueName} · until ${until}` };
    title = `CHECKED IN · ${current.venueName.toUpperCase()}`;
    sections.push(
      <Text key="until" style={t.sub}>
        Until {until}. Friends see you here.
      </Text>,
    );
    sections.push(<CheckinPlanLine key="plan" checkinId={current.queued ? null : current.id} venueName={current.venueName} />);
    if (current.private) {
      sections.push(
        <Text key="private" style={t.sub}>
          Only you see this check-in: an older version of Pickleague made it without your location. Check out, then
          check in again at the court to show up there.
        </Text>,
      );
    }
    actions = [
      {
        label: '▶  Start playing',
        onPress: () => {
          setExpanded(false);
          openPlayStart({ venue: { id: current.venueId, name: current.venueName } });
        },
      },
      ...(!current.queued
        ? [
            {
              label: 'Stay 1 more hour',
              variant: 'secondary' as const,
              timeoutMs: CHECKIN_BOUND_MS + 1_000,
              onPress: () => extend(current),
            },
          ]
        : []),
      {
        label: 'Check out',
        variant: 'secondary',
        timeoutMs: CHECKOUT_BOUND_MS + 1_000,
        onPress: () => out(current),
      },
    ];
  } else if (nearby) {
    pill = { primary: `AT ${nearby.name.toUpperCase()}?` };
    title = `AT ${nearby.name.toUpperCase()}?`;
    sections.push(
      <Text key="ask" style={t.sub}>
        Check in for 2 hours, so friends can find you.
      </Text>,
    );
    actions = [
      {
        label: 'Check in',
        timeoutMs: CHECKIN_BOUND_MS + 1_000,
        onPress: () => flow.checkIn({ id: nearby.id, name: nearby.name }),
      },
      { label: 'Not here', variant: 'secondary', onPress: () => clearNotes() },
    ];
  } else if (finding) {
    pill = { primary: busy === 'find' ? 'Finding your court…' : 'Checking you in…' };
    title = 'CHECK IN';
  } else {
    pill = { primary: 'Check in', secondary: 'Tap for details' };
    title = 'CHECK IN';
    actions = [
      { label: 'Pick a court', onPress: () => setPicking(true) },
      { label: 'OK', variant: 'secondary', onPress: () => clearNotes() },
    ];
  }

  sections.push(
    <CourtCheckInNotes key="notes" flow={flow}>
      {offerUntracked && !busy ? (
        <Button title="Start without a court" size="sm" variant="outline" onPress={startUntracked} style={S.hug} />
      ) : null}
      {addAt && !current && !busy ? (
        <Button
          title="Add this court"
          size="sm"
          variant="outline"
          onPress={() => {
            const at = addAt;
            clearNotes();
            navigateWhenReady('SubmitVenue', { lat: at.lat, lng: at.lng });
          }}
          style={S.hug}
        />
      ) : null}
    </CourtCheckInNotes>,
  );

  return (
    <>
      <LiveStatusIsland
        visible={visible}
        expanded={visible && expanded}
        onExpandedChange={setExpanded}
        anchor="bottom"
        style={position}
        pill={pill}
        title={title}
        sections={sections}
        actions={actions}
        pulseColor={current ? c.success : c.primary}
        accessibilityLabel={current ? `Checked in at ${current.venueName}` : 'Check in'}
      />
      <CourtPicker
        visible={picking}
        onClose={() => setPicking(false)}
        onPick={(court) => {
          setPicking(false);
          setMessage(null);
          setAddAt(null);
          void flow.checkIn(court);
        }}
      />
    </>
  );
}

/** "Which court?": my league home courts, starred and recent courts. */
function CourtPicker({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (court: { id: string; name: string }) => void;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [courts, setCourts] = useState<CourtCandidate[] | null>(null);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setCourts(null);
    void (async () => {
      const groups: Partial<Record<CourtReason, { id: string; name: string }[]>> = {};
      try {
        const uid = await currentUserId(supabase);
        if (uid) {
          const [leagues, favorites, recent] = await Promise.all([
            getMyLeagueCourts(uid).catch(() => []),
            listMyCourtFavorites().catch(() => []),
            getMyRecentCourts(uid).catch(() => []),
          ]);
          const homeIds = [...new Set(leagues.map((l) => l.home_venue_id).filter((id): id is string => !!id))];
          groups.home = await getVenuesByIds(homeIds).catch(() => []);
          groups.favorite = favorites.map((f) => ({ id: f.venue_id, name: f.venue_name }));
          groups.recent = recent;
        }
      } finally {
        if (alive) setCourts(mergeCourtCandidates(groups, 8));
      }
    })();
    return () => {
      alive = false;
    };
  }, [visible]);
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Which court?">
      <ScrollView contentContainerStyle={S.list} keyboardShouldPersistTaps="handled">
        {courts === null ? <Text style={t.hint}>Loading your courts…</Text> : null}
        {courts?.length === 0 ? (
          <Text style={t.sub}>No courts yet. Star a court on Discover, or add the one you're at.</Text>
        ) : null}
        {courts?.map((x) => (
          <TouchableOpacity
            key={x.id}
            style={[S.row, { borderColor: c.border, backgroundColor: c.bg }]}
            onPress={() => onPick({ id: x.id, name: x.name })}
            accessibilityRole="button"
            accessibilityLabel={`${x.name}, ${courtNote(x.reason)}`}
          >
            <Text style={t.title} numberOfLines={1}>
              📍 {x.name}
            </Text>
            <Text style={t.meta}>{courtNote(x.reason)}</Text>
          </TouchableOpacity>
        ))}
        <Text style={[t.hint, S.hint]}>You need to be at the court: your location checks you in.</Text>
      </ScrollView>
    </BottomSheet>
  );
}

const S = StyleSheet.create({
  hug: { alignSelf: 'flex-start' },
  list: { gap: SPACE.sm, paddingBottom: SPACE.md },
  row: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    borderWidth: HAIRLINE,
    borderRadius: RADIUS.md,
    gap: SPACE.xxs,
  },
  hint: { marginTop: SPACE.sm },
});
