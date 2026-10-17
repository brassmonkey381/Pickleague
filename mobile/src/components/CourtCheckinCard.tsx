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
// offer to turn on court arrival alerts (otherwise only in Settings). "Play
// now" / "Start playing" open the "Where are you playing?" sheet.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Panel } from '@just-messin-around/expo-foundation/ui';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { useTheme } from '../lib/ThemeContext';
import {
  askForLocation,
  checkInAt,
  checkinChanged,
  checkinRejected,
  checkOut,
  extendCheckinByHour,
  noFixReason,
  peekCurrentCheckin,
  refreshCurrentCheckin,
  takeCheckinFix,
  takeEndedCheckinNote,
  takeFixIfAllowed,
  takeRejectedCheckinNotice,
  type CurrentCheckin,
} from '../lib/courtCheckin';
import { explainRefusal } from '../lib/refusalNotices';
import { refusalCode, refusalCopy, type RefusalContext } from '../lib/refusals';
import {
  CHECKOUT_FIX_WAIT_MS,
  FIX_REUSE_MS,
  isFixFresh,
  offersUntrackedSession,
  type DeviceFix,
} from '../lib/courtCheckinRules';
import { resolveCourtAt, type ResolvedCourt } from '../data/venueCheckins';
import { PlayersHerePile, PlayersHereRoster, usePlayersHere } from './PlayersHereList';
import PauseSharingChip from './presence/PauseSharingChip';
import CrowdLine from './court/CrowdLine';
import { noteGoodMoment } from '../lib/ratingPrompt';
import { openPlayStart, playSession, startPlay } from '../lib/playSession';
import { ensurePresenceConsent } from '../lib/presenceConsent';
import { getCourtAlertsEnabled, setCourtAlertsEnabled } from '../lib/courtGeofence';
import type { RootStackParamList } from '../types';

const BOUND_MS = 10_000;
// Check in may first wait up to 6 s for a fix, then the write.
const CHECKIN_BOUND_MS = 16_000;
// Check out waits at most 3 s for its stay-proof fix, then the write as before.
const CHECKOUT_BOUND_MS = BOUND_MS + CHECKOUT_FIX_WAIT_MS;
// Set the moment the arrival-alerts offer is shown, so it never asks twice.
const ALERTS_OFFERED_KEY = 'pickleague_court_alerts_offered_v1';
const ALWAYS_LABEL = Platform.OS === 'android' ? 'Allow all the time' : 'Always';

/** True once per device: native, alerts off, never offered. Marks it offered. */
async function claimAlertsOffer(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    if (await AsyncStorage.getItem(ALERTS_OFFERED_KEY)) return false;
    if (await getCourtAlertsEnabled()) return false;
    await AsyncStorage.setItem(ALERTS_OFFERED_KEY, '1');
    return true;
  } catch {
    return false; // can't remember we asked, so don't ask
  }
}

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
  | 'alerts_not_now';

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
  const [busy, setBusy] = useState<null | 'find' | 'checkin' | 'extend' | 'out'>(null);
  const [message, setMessage] = useState<string | null>(null);
  // No fix, or a fix outside the fence: offer an untracked session instead.
  const [offerUntracked, setOfferUntracked] = useState(false);
  const [rosterKey, setRosterKey] = useState(0);
  // The fix "Find my court" used; Check in reuses it while it is recent.
  const lastFix = useRef<DeviceFix | null>(null);
  // Where "Find my court" found nothing: offered as "Add this court".
  const [addAt, setAddAt] = useState<{ lat: number; lng: number } | null>(null);
  const [alertsOffer, setAlertsOffer] = useState<null | 'ask' | 'busy'>(null);
  const [alertsResult, setAlertsResult] = useState<string | null>(null);
  const playing = playSession.useLiveSession().status !== 'idle';
  const mode: CourtCardMode = current ? 'checked_in' : nearby ? 'prompt' : 'idle';

  useEffect(() => {
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  useEffect(() => {
    void peekCurrentCheckin().then(setCurrent);
    return checkinChanged.subscribe(setCurrent);
  }, []);

  useFocusEffect(
    useCallback(() => {
      // Offline: keep the cached check-in. A check-in that ended without my
      // Check out here (ran out, or closed elsewhere) says so once.
      refreshCurrentCheckin()
        .then(async (c) => {
          setCurrent(c);
          // Only the signed-in player's own (never the previous account's).
          const ended = await takeEndedCheckinNote();
          if (ended && !c) setMessage(ended);
        })
        .catch(() => {});
      // A queued check-in the server refused while I was away.
      void takeRejectedCheckinNotice().then((notice) => notice && setMessage(notice));
    }, []),
  );
  // ...or while the card is on screen (marked shown so focus doesn't repeat it).
  useSignal(checkinRejected, () => {
    void takeRejectedCheckinNotice().then((notice) => notice && setMessage(notice));
  });

  async function run(
    kind: NonNullable<typeof busy>,
    fn: () => Promise<void>,
    failMsg: string,
    opts: { boundMs?: number; askLocation?: boolean; consent?: boolean; refusal?: RefusalContext } = {},
  ) {
    setBusy(kind);
    setMessage(null);
    setOfferUntracked(false);
    setAlertsResult(null);
    try {
      // The one-time "who sees you at the courts" sheet and the permission
      // sheet wait on the player, so they sit outside the bound; the fix and
      // the write don't. Not now on the consent sheet: no check-in, and the
      // card says why (rule 11: nothing refused silently).
      if (opts.consent && !(await ensurePresenceConsent())) {
        setMessage(refusalCopy('consent.declined'));
        return;
      }
      if (opts.askLocation) await askForLocation();
      await withTimeout(fn(), opts.boundMs ?? BOUND_MS);
    } catch (e) {
      // Why, then what to do (lib/refusals): how far from the court, too
      // vague, too old, the court is gone, the check-in already ended,
      // signed out.
      setMessage(explainRefusal(e, failMsg, opts.refusal));
      if (kind === 'checkin' && offersUntrackedSession(e)) setOfferUntracked(true);
      // A check-in the server already ended: stop showing it.
      const code = refusalCode(e);
      if (code === 'checkin.closed' || code === 'checkin.none') {
        void refreshCurrentCheckin().then(setCurrent).catch(() => {});
      }
    } finally {
      setBusy(null);
    }
  }

  /** No fix: say why, and offer the untracked session. */
  async function noFix() {
    setMessage(await noFixReason());
    setOfferUntracked(true);
  }

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

  const checkIn = (v: ResolvedCourt) =>
    run(
      'checkin',
      async () => {
        const fix = isFixFresh(lastFix.current, Date.now(), FIX_REUSE_MS) ? lastFix.current : await takeCheckinFix(6_000);
        if (!fix) return noFix();
        lastFix.current = fix;
        const next = await checkInAt({ id: v.id, name: v.name }, fix);
        setCurrent(next);
        setNearby(null);
        setAddAt(null);
        setRosterKey((k) => k + 1);
        if (next.queued) setMessage('Saved with no signal. It counts if it syncs within 2 minutes.');
        else {
          noteGoodMoment(); // a check-in that went through (rating prompt)
          void claimAlertsOffer().then((show) => show && setAlertsOffer('ask'));
        }
      },
      "Couldn't check you in. Try again.",
      {
        boundMs: CHECKIN_BOUND_MS,
        askLocation: true,
        consent: true,
        refusal: { venueName: v.name, action: 'check_in' },
      },
    );

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

  // Same path as the Settings toggle: the OS sheets ask for Always location;
  // 0 fenced courts means it couldn't start, so leave it off. Not bounded:
  // the user may sit on the permission sheet.
  async function turnOnAlerts() {
    setAlertsOffer('busy');
    try {
      const n = await setCourtAlertsEnabled(true);
      if (n === 0) {
        await setCourtAlertsEnabled(false);
        setAlertsResult(
          `Arrival alerts are off: they need location set to "${ALWAYS_LABEL}". Change it in your phone's Settings for Pickleague, then turn them on in Settings > Court Arrival Alerts.`,
        );
      } else {
        setAlertsResult(
          `Arrival alerts are on for ${n} court${n === 1 ? '' : 's'}. You'll get a notification with a Check in button; it never checks you in on its own.`,
        );
      }
    } catch {
      await setCourtAlertsEnabled(false).catch(() => 0);
      setAlertsResult("Couldn't turn on arrival alerts. Try again in Settings > Court Arrival Alerts.");
    } finally {
      setAlertsOffer(null);
    }
  }

  const tap = (target: CourtCardTap, fn: () => void) => () => {
    onTap?.(target);
    fn();
  };

  // Outcome lines and the one-time offers render under either look.
  const footer = (
    <>
      {message ? <Text style={[t.sub, S.gapSm]}>{message}</Text> : null}
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
      {alertsOffer ? (
        <View style={S.offer}>
          <Text style={t.body}>Get a nudge when you arrive here next time?</Text>
          <Text style={[t.sub, S.gapSm]}>
            A notification with a Check in button. It never checks you in on its own. Needs location set to "
            {ALWAYS_LABEL}".
          </Text>
          <View style={S.row}>
            <Button
              title="Turn on"
              size="sm"
              loading={alertsOffer === 'busy'}
              disabled={alertsOffer === 'busy'}
              onPress={() => {
                onTap?.('alerts_on');
                void turnOnAlerts();
              }}
            />
            <Button
              title="Not now"
              size="sm"
              variant="outline"
              disabled={alertsOffer === 'busy'}
              onPress={tap('alerts_not_now', () => setAlertsOffer(null))}
            />
          </View>
        </View>
      ) : null}
      {alertsResult ? <Text style={[t.sub, S.gapSm]}>{alertsResult}</Text> : null}
    </>
  );

  if (current) {
    // NOW: "📍 Lake Merritt · checked in · til 7:30", then who's here next to
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
          <Text style={[t.title, S.flex]} numberOfLines={1}>
            📍 {current.venueName}
            <Text style={t.sub}> · checked in · til {timeLabel(current.expiresAt)}</Text>
          </Text>
          {!playing && (
            <Button
              title="Start playing"
              size="sm"
              variant="success"
              disabled={!!busy}
              onPress={tap('start_playing', () => openPlayStart())}
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
    return (
      <Panel padded={false} emphasis style={S.panel}>
        <View style={S.line}>
          <Text style={t.title} numberOfLines={2}>
            📍 Check in at {nearby.name} for 2 hours?
          </Text>
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
        <CrowdLine venueId={nearby.id} venueName={nearby.name} star />
        {footer}
      </Panel>
    );
  }

  // Idle: the 48px court row. "Play now" opens the start sheet (court found
  // from a fix, or no court at all); it hides while a session already runs.
  return (
    <Panel padded={false} style={S.panel}>
      <View style={S.courtRow}>
        <Text style={[t.title, S.flex]} numberOfLines={1}>
          📍 At the courts?
        </Text>
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
        <TouchableOpacity
          style={S.link}
          activeOpacity={0.6}
          disabled={!!busy}
          onPress={tap('find_court', () => {
            void findCourt();
          })}
          accessibilityRole="button"
          accessibilityLabel="Find my court"
        >
          <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            Find my court ›
          </Text>
        </TouchableOpacity>
      </View>
      {footer}
    </Panel>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
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
    row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.sm },
    flex: { flex: 1, minWidth: 0 },
    link: { minHeight: 44, minWidth: 44, paddingHorizontal: SPACE.xs, alignItems: 'center', justifyContent: 'center' },
    hug: { alignSelf: 'flex-start' },
    gapSm: { marginTop: SPACE.xs, marginBottom: SPACE.xs },
    offer: { marginTop: SPACE.sm, paddingVertical: SPACE.sm, borderTopWidth: 1, borderTopColor: c.border },
  });
}
