// "Check in at a court" + who's here now. Home screen card; works on web too
// (the browser asks for location, and only when "Find my court" is tapped).
//
// Two looks, ONE mounted component (plan section 3, layout C): idle, it is the
// 48px court row ("At the courts?  Find my court ›") near the bottom of Home;
// checked in, or offering a check-in, it is the NOW panel's court block under
// the greeting: two 44 lines (about 120 with NOW's header), the second one
// "(A)(B)(C) +4 here   [+1 h] [Check out]". Tapping the avatars shows the full
// roster underneath; it is never rendered unasked. Home moves this same keyed element between the two spots and
// never unmounts it, because the 'home/' push target (the check-in reminder and
// the court-arrival notice) lands here and relies on its state and listeners.
// `onModeChange` tells Home which spot it belongs in.
//
// No manual check-ins (docs/play-sessions-presence.md, decision 6): "Find my
// court" and Check in each take a fresh device fix, and the server confirms it
// is inside the court's fence. No permission, no fix, or only an approximate
// one (Precise Location off) means no check-in; the card says why and offers
// "Start without a court" (an untracked session) instead, and never offers
// "Add this court" at a blurred spot. Every refusal says why and what to do
// (rule 11, lib/refusals): a fix outside the fence reads "You're about 240 m
// from Lakeside. You need to be at the court to check in, so try again when
// you get there."; Not now on the consent sheet says the check-in needs that
// choice first. A queued check-in the server refused later is reported here
// the next time the card shows (and as a toast on any screen), and so is a
// check-in that ended without a Check out here. +1 h sends a fix when location
// is allowed, so the check-in stays confirmed (the server stops a fix-less one
// 4 hours after its last fix); when it gives less than an hour, the card says.
//
// Every button is bounded (10 s; 16 s when it first waits for a fix; the
// location permission sheet itself is not timed) and resets its busy state in
// `finally`, so a dead connection can never leave a spinner running.
//
// No court in range offers "Add this court" (SubmitVenue, prefilled with the
// spot). After the first check-in that goes through, native shows a one-time
// offer to star that court, so arriving there next time checks you in; it
// stars, then asks for "Always" location (otherwise the ☆ in the header, or
// Settings > Check-in automation). "Play now" / "Start playing" open the
// "Where are you playing?" sheet.
//
// The check-in flow itself (consent, the location ask, the bounds, the
// refusal lines, the queued note, the star offer) is lib/useCourtCheckIn,
// shared with a court's page; its lines render through CourtCheckInNotes.
// With COURT_DISCOVERY_ENABLED the idle row also offers "Discover courts ›".
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Panel, TextLink } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { useTheme } from '../lib/ThemeContext';
import {
  checkinChanged,
  checkinRejected,
  checkOut,
  extendCheckinByHour,
  peekCurrentCheckin,
  readRoutinesForCheckin,
  refreshCurrentCheckin,
  takeCheckinFix,
  takeEndedCheckinNote,
  takeFixIfAllowed,
  takeRejectedCheckinNotice,
  type CurrentCheckin,
} from '../lib/courtCheckin';
import { CHECKOUT_FIX_WAIT_MS, FIX_REUSE_MS, isFixFresh } from '../lib/courtCheckinRules';
import { routineCheckinUntil, type CourtRoutine } from '../lib/courtRoutineRules';
import { CHECKIN_BOUND_MS, CHECKIN_BOUND_MS_DEFAULT, useCourtCheckIn } from '../lib/useCourtCheckIn';
import { resolveCourtAt, type ResolvedCourt } from '../data/venueCheckins';
import { PlayersHerePile, PlayersHereRoster, usePlayersHere } from './PlayersHereList';
import PauseSharingChip from './presence/PauseSharingChip';
import CrowdLine from './court/CrowdLine';
import CourtFavoriteStar from './court/CourtFavoriteStar';
import CourtCheckInNotes from './court/CourtCheckInNotes';
import CheckinPlanLine from './routines/CheckinPlanLine';
import { openPlayStart, playSession, startPlay } from '../lib/playSession';
import { COURT_DISCOVERY_ENABLED } from '../lib/features';
import { openDiscover } from '../lib/discoverNav';
import { checkinHostOwnsNotes } from '../lib/checkinHost';
import type { RootStackParamList } from '../types';

// Check out waits at most 3 s for its stay-proof fix, then the write as before.
const CHECKOUT_BOUND_MS = CHECKIN_BOUND_MS_DEFAULT + CHECKOUT_FIX_WAIT_MS;

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Roster rows once the avatars are tapped (the old always-on cap). */
const ROSTER_MAX_ROWS = 3;

/**
 * The NOW block's second line: who's here on the left, the actions on the
 * right. One fetch feeds both the pile and the roster it expands. The line
 * wraps the buttons under the pile only when they don't fit (a narrow phone or
 * large text): rows grow, they don't clip.
 */
function HereLine({ venueId, children }: { venueId: string | null; children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return venueId ? (
    <HereLineWithRoster venueId={venueId} expanded={expanded} onToggle={() => setExpanded((x) => !x)}>
      {children}
    </HereLineWithRoster>
  ) : (
    // A check-in saved offline has no roster to show yet.
    <View style={lineStyles.row}>
      <View style={lineStyles.pile} />
      <View style={lineStyles.buttons}>{children}</View>
    </View>
  );
}

function HereLineWithRoster({
  venueId,
  expanded,
  onToggle,
  children,
}: {
  venueId: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const { players, failed } = usePlayersHere(venueId);
  return (
    <>
      <View style={lineStyles.row}>
        <PlayersHerePile players={players} failed={failed} expanded={expanded} onPress={onToggle} style={lineStyles.pile} />
        <View style={lineStyles.buttons}>{children}</View>
      </View>
      {expanded && players && players.length > 0 ? <PlayersHereRoster players={players} maxRows={ROSTER_MAX_ROWS} /> : null}
    </>
  );
}

const lineStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: SPACE.sm,
    minHeight: 44,
  },
  pile: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginLeft: 'auto' },
});

/** idle = the court row; checked_in / prompt = the NOW block. */
export type CourtCardMode = 'idle' | 'checked_in' | 'prompt';

/** What was tapped (home.tap targets). */
export type CourtCardTap =
  | 'find_court'
  | 'play_now'
  | 'start_untracked'
  | 'check_in'
  | 'not_here'
  | 'extend'
  | 'check_out'
  | 'start_playing'
  | 'add_court'
  | 'alerts_on'
  | 'alerts_not_now'
  | 'browse_courts';

type Props = {
  onModeChange?: (mode: CourtCardMode) => void;
  onTap?: (target: CourtCardTap) => void;
};

export default function CourtCheckinCard({ onModeChange, onTap }: Props = {}) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);
  const [current, setCurrent] = useState<CurrentCheckin | null>(null);
  const [nearby, setNearby] = useState<ResolvedCourt | null>(null);
  const [rosterKey, setRosterKey] = useState(0);
  // Where "Find my court" found nothing: offered as "Add this court".
  const [addAt, setAddAt] = useState<{ lat: number; lng: number } | null>(null);
  // The shared check-in flow (busy, the outcome line, the untracked offer,
  // the fix "Find my court" took, the one-time star offer).
  const flow = useCourtCheckIn({
    onCheckedIn: (next) => {
      setCurrent(next);
      setNearby(null);
      setAddAt(null);
      setRosterKey((k) => k + 1);
    },
    onCurrent: setCurrent,
  });
  const { busy, setMessage, offerUntracked, setOfferUntracked, lastFix, run, noFix } = flow;
  const playing = playSession.useLiveSession().status !== 'idle';
  const mode: CourtCardMode = current ? 'checked_in' : nearby ? 'prompt' : 'idle';

  useEffect(() => {
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  useEffect(() => {
    void peekCurrentCheckin().then(setCurrent);
    return checkinChanged.subscribe(setCurrent);
  }, []);

  // How long Check in here asks for: to the end of a routine stop due here
  // with its occurrence (manualCheckinMinutes), else 2 hours. My routines are
  // read when a court is found and on a minute tick (this phone's copy, read
  // fresh only while a stop is due here without an occurrence in it, as the
  // tap does), which also readies them for the tap; the end itself is worked
  // out on each render, so "until" never drifts and follows a stop's window
  // opening or closing while the card is up.
  const [nearbyRoutines, setNearbyRoutines] = useState<CourtRoutine[] | null>(null);
  const [, setMinuteTick] = useState(0);
  const nearbyId = nearby?.id ?? null;
  useEffect(() => {
    setNearbyRoutines(null);
    if (!nearbyId) return;
    let live = true;
    const read = () =>
      readRoutinesForCheckin(nearbyId)
        .then((r) => {
          if (live) setNearbyRoutines(r);
        })
        .catch(() => {});
    void read();
    const tick = setInterval(() => {
      setMinuteTick((n) => n + 1);
      void read();
    }, 60_000);
    return () => {
      live = false;
      clearInterval(tick);
    };
  }, [nearbyId]);

  useFocusEffect(
    useCallback(() => {
      // Offline: keep the cached check-in. A check-in that ended without my
      // Check out here (ran out, or closed elsewhere) says so once.
      // With the bottom bar, the root CheckinHost owns the once-only notes
      // (plan C1): taking them here too would say one twice, or race it away.
      const ownsNotes = !checkinHostOwnsNotes();
      refreshCurrentCheckin()
        .then(async (c) => {
          setCurrent(c);
          if (!ownsNotes) return;
          // Only the signed-in player's own (never the previous account's).
          const ended = await takeEndedCheckinNote();
          if (ended && !c) setMessage(ended);
        })
        .catch(() => {});
      // A queued check-in the server refused while I was away.
      if (ownsNotes) void takeRejectedCheckinNotice().then((notice) => notice && setMessage(notice));
    }, []),
  );
  // ...or while the card is on screen (marked shown so focus doesn't repeat it).
  useSignal(checkinRejected, () => {
    if (checkinHostOwnsNotes()) return;
    void takeRejectedCheckinNotice().then((notice) => notice && setMessage(notice));
  });

  const findCourt = () =>
    run(
      'find',
      async () => {
        setAddAt(null);
        // A fresh fix only: a remembered spot can't confirm I am at the court.
        const fix = await takeCheckinFix(6_000);
        if (!fix) return noFix();
        lastFix.current = fix;
        const v = await resolveCourtAt(fix.lat, fix.lng, 150);
        setNearby(v);
        if (!v) {
          setMessage('No court found within 150 m of you.');
          setAddAt({ lat: fix.lat, lng: fix.lng });
        }
      },
      "Couldn't look up nearby courts. Try again.",
      { askLocation: true },
    );

  const checkIn = (v: ResolvedCourt) => flow.checkIn({ id: v.id, name: v.name });

  // The untracked session: a timer only I see, no court, no presence.
  const startUntracked = () => {
    setMessage(null);
    setOfferUntracked(false);
    setNearby(null);
    startPlay({ kind: 'open_play', sourceId: null, venueId: null, venueName: null });
  };

  // A fix (only when location is already allowed: +1 h never prompts) keeps
  // the check-in confirmed; without one the server extends only so far.
  const extend = (cur: CurrentCheckin) =>
    run(
      'extend',
      async () => {
        const fix = isFixFresh(lastFix.current, Date.now(), FIX_REUSE_MS)
          ? lastFix.current
          : await takeFixIfAllowed(6_000);
        if (fix) lastFix.current = fix;
        const { next, note } = await extendCheckinByHour(cur, fix);
        if (next) setCurrent(next);
        // Less than the hour asked for (no confirming fix): say why.
        if (!note.full) setMessage(note.message);
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
        setRosterKey((k) => k + 1);
      },
      "Couldn't check you out. Try again.",
      { boundMs: CHECKOUT_BOUND_MS, refusal: { venueName: cur.venueName } },
    );

  const tap = (target: CourtCardTap, fn: () => void) => () => {
    onTap?.(target);
    fn();
  };

  // Outcome lines and the one-time offers render under either look.
  const footer = (
    <CourtCheckInNotes flow={flow} onStarOfferTap={(target) => onTap?.(target)}>
      {offerUntracked && !playing && !busy ? (
        <Button
          title="Start without a court"
          size="sm"
          variant="outline"
          onPress={tap('start_untracked', startUntracked)}
          style={S.hug}
        />
      ) : null}
      {addAt && !current && !nearby && !busy ? (
        <Button
          title="Add this court"
          size="sm"
          variant="outline"
          onPress={tap('add_court', () => {
            // Cleared so coming back doesn't offer the just-added court again.
            setAddAt(null);
            setMessage(null);
            navigation.navigate('SubmitVenue', { lat: addAt.lat, lng: addAt.lng });
          })}
          style={S.hug}
        />
      ) : null}
    </CourtCheckInNotes>
  );

  if (current) {
    // NOW: "(pin) Lake Merritt · checked in · til 7:30", then who's here next to
    // the actions. "Start playing" rides the title line (the plan's second line
    // only fits [+1 h] [Check out] beside the avatars) and opens the start
    // sheet with this court preselected. "Start playing" and "+1 h" hide while
    // a play session runs, because the floating PlayIsland shows that same
    // button then (one place per action). Sessions are presence: one started
    // at a court checks you in there (or adopts this check-in), so this block
    // shows while you play. The island's End closes only a check-in the
    // session opened; Check out stays for the one you made yourself.
    return (
      <Panel padded={false} emphasis style={S.panel}>
        <View style={[S.line, S.titleRow]}>
          <View style={[S.flex, S.inline]}>
            <Icon name="pin" size={14} color={c.textSub} />
            <Text style={[t.title, S.shrink]} numberOfLines={1}>
              {current.venueName}
              <Text style={t.sub}> · checked in · til {timeLabel(current.expiresAt)}</Text>
            </Text>
          </View>
          {/* Star the court you're at: next time, arriving checks you in. */}
          <CourtFavoriteStar venueId={current.venueId} venueName={current.venueName} />
          {!playing && (
            <Button
              title="Start playing"
              size="sm"
              variant="success"
              disabled={!!busy}
              onPress={tap('start_playing', () =>
                openPlayStart({ venue: { id: current.venueId, name: current.venueName } }),
              )}
            />
          )}
        </View>
        <HereLine key={`${current.venueId}:${rosterKey}`} venueId={current.queued ? null : current.venueId}>
          {!playing && (
            <Button
              title="+1 h"
              size="sm"
              variant="outline"
              loading={busy === 'extend'}
              disabled={!!busy || !!current.queued}
              onPress={tap('extend', () => {
                void extend(current);
              })}
            />
          )}
          <Button
            title="Check out"
            size="sm"
            variant="danger"
            loading={busy === 'out'}
            disabled={!!busy}
            onPress={tap('check_out', () => {
              void out(current);
            })}
          />
        </HereLine>
        {/* Routines: how long and Closed group / Open play, "Switch to open play now". */}
        <CheckinPlanLine checkinId={current.queued ? null : current.id} venueName={current.venueName} style={S.gapSm} />
        {current.private ? (
          // An older build checked in without a fix: stored, but shown to
          // nobody and counted nowhere (rule 1). Say so, and how to fix it.
          <Text style={[t.sub, S.gapSm]}>
            Only you see this check-in: an older version of Pickleague made it without your location. Check out, then
            check in again at the court to show up there.
          </Text>
        ) : null}
        <PauseSharingChip style={S.hug} />
        {footer}
      </Panel>
    );
  }

  if (nearby) {
    // What the tap asks for now (checkInAt reads the same routines then).
    const nearbyUntil = nearbyRoutines ? routineCheckinUntil(nearbyRoutines, nearby.id, new Date()) : null;
    return (
      <Panel padded={false} emphasis style={S.panel}>
        <View style={[S.line, S.titleRow]}>
          <View style={[S.flex, S.inline]}>
            <Icon name="pin" size={14} color={c.textSub} />
            <Text style={[t.title, S.shrink]} numberOfLines={2}>
              Check in at {nearby.name}{' '}
              {nearbyUntil ? `until ${timeLabel(nearbyUntil)}` : 'for 2 hours'}?
            </Text>
          </View>
          <CourtFavoriteStar venueId={nearby.id} venueName={nearby.name} />
        </View>
        <HereLine key={`${nearby.id}:${rosterKey}`} venueId={nearby.id}>
          <Button
            title="Check in"
            size="sm"
            loading={busy === 'checkin'}
            disabled={!!busy}
            onPress={tap('check_in', () => {
              void checkIn(nearby);
            })}
          />
          <Button
            title="Not here"
            size="sm"
            variant="outline"
            disabled={!!busy}
            onPress={tap('not_here', () => setNearby(null))}
          />
        </HereLine>
        {/* No star here: the header has it (one per court on the card). */}
        <CrowdLine venueId={nearby.id} venueName={nearby.name} />
        {footer}
      </Panel>
    );
  }

  // Idle: the 48px court row. "Play now" opens the start sheet (court found
  // from a fix, or no court at all); it hides while a session already runs.
  return (
    <Panel padded={false} style={S.panel}>
      <View style={S.courtRow}>
        <View style={[S.flex, S.inline]}>
          <Icon name="pin" size={14} color={c.textSub} />
          <Text style={[t.title, S.shrink]} numberOfLines={1}>
            At the courts?
          </Text>
        </View>
        {busy === 'find' ? <ActivityIndicator color={c.primary} /> : null}
        {!playing && (
          <TouchableOpacity
            style={S.link}
            activeOpacity={0.6}
            disabled={!!busy}
            onPress={tap('play_now', () => openPlayStart())}
            accessibilityRole="button"
            accessibilityLabel="Play now"
            accessibilityHint="Pick where you are playing and start a session"
          >
            <Text style={[t.meta, { color: c.textSub }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              Play now
            </Text>
          </TouchableOpacity>
        )}
        <TextLink
          label="Find my court"
          style={S.textLink}
          onPress={() => {
            if (busy) return;
            tap('find_court', () => {
              void findCourt();
            })();
          }}
        />
      </View>
      {COURT_DISCOVERY_ENABLED ? (
        // Its own line: the row above has no room left at 375 px.
        <TextLink
          label="Discover courts"
          style={[S.textLink, S.browse]}
          onPress={tap('browse_courts', () => openDiscover(navigation, { tab: 'places' }))}
          accessibilityHint="Shows the courts near you, as a list or a map"
        />
      ) : null}
      {footer}
    </Panel>
  );
}

function makeStyles(_c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    // Panel's chrome (radius 14) with this card's own inset. `padded={false}`
    // sets no padding of its own (foundation 1.42), so this applies on web too.
    // Checked in or offering a check-in it is the Emphasis variant (one per
    // screen; HomeScreen gives NOW's other panel none while this one shows).
    panel: { paddingHorizontal: SPACE.md, paddingVertical: SPACE.xxs },
    // The court row: 48 tall (44 tap boxes inside the 2px inset).
    courtRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 44 },
    line: { minHeight: 44, justifyContent: 'center' },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    flex: { flex: 1, minWidth: 0 },
    // A pin glyph beside the title, centred on its line.
    inline: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
    shrink: { flexShrink: 1 },
    link: { minHeight: 44, minWidth: 44, paddingHorizontal: SPACE.xs, alignItems: 'center', justifyContent: 'center' },
    textLink: { paddingHorizontal: SPACE.xs },
    browse: { alignSelf: 'flex-end' },
    hug: { alignSelf: 'flex-start' },
    gapSm: { marginTop: SPACE.xs, marginBottom: SPACE.xs },
  });
}
