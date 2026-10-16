// "Where are you playing?": the one way a play session starts (Doggle's
// WalkStartSheet). Opens from the court card (Play now, Start playing) and from
// the "starting now" notice's Start session button, all through
// lib/playSession's openPlayStart(); when a session already runs, that expands
// the island instead.
//
// The court is preselected in this order: my current check-in; the court I am
// standing in (a fresh fix of at most 6 s, only when location is already
// allowed: opening the sheet never prompts); then my league home courts,
// favorites and recent courts. Start sends a fresh fix with the court, which is
// what checks me in there (no manual check-ins), except at my current
// check-in's court: the server adopts that confirmed check-in without one. No
// fix means no presence, so the sheet says so and offers to start without a
// court. A fix that isn't at the chosen court says so too ("You're not at
// ...") and offers the court I am at, no court, or starting anyway (a timer at
// that court that shows me to nobody). "No court, just time it" is a private
// timer. The line under the list promises "Visible to ..." only for a court I
// seem to be at.
//
// Closing the sheet (or opening it again) while Start waits on location
// cancels that Start: nothing is started or shared after the player backed out.
//
// The host is mounted once at the app root next to PlayIsland
// (navigation/AppNavigator), outside the navigator, so it navigates through
// navigateWhenReady. The one-time "who sees you at the courts" sheet
// (lib/presenceConsent) is asked BEFORE this sheet opens: it is a Modal too,
// and iOS won't present a second Modal over this one. "Not now" there still
// opens this sheet, with only the private timer (no court, no location read).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { BottomSheet, SegmentedToggle } from '@just-messin-around/expo-foundation/ui';
import { HAIRLINE, RADIUS, SMALL_TEXT_MAX_SCALE, SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../../lib/supabase';
import { useTheme } from '../../lib/ThemeContext';
import { navigateWhenReady } from '../../lib/navigationRef';
import { whenPhrase } from '../../lib/agenda';
import { ensurePresenceConsent } from '../../lib/presenceConsent';
import { askForLocation, noFixReason, peekCurrentCheckin, takeCheckinFix, takeFixIfAllowed } from '../../lib/courtCheckin';
import { FIX_REUSE_MS, isFixFresh, type DeviceFix } from '../../lib/courtCheckinRules';
import {
  playIslandExpand,
  playSession,
  playStartRequested,
  startPlay,
  takePlayStartRequest,
  type PlayStartRequest,
} from '../../lib/playSession';
import {
  atSelectedCourt,
  courtNote,
  mergeCourtCandidates,
  startNeedsFix,
  visibilityLine,
  type CheckinVisibility,
  type CourtCandidate,
  type CourtReason,
} from '../../lib/playStartCourts';
import {
  getMyLeagueCourts,
  getMyRecentCourts,
  getVenuesByIds,
  resolveCourtAt,
  type ResolvedCourt,
} from '../../data/venueCheckins';
import { listMyCourtFavorites } from '../../data/courtFavorites';
import { loadPresenceSettings } from '../../data/presenceSettings';
import type { PlayKind } from '../../data/playSessions';

type ChipKind = Extract<PlayKind, 'open_play' | 'drill' | 'match'>;
const KINDS: { value: ChipKind; label: string }[] = [
  { value: 'open_play', label: 'Open play' },
  { value: 'drill', label: 'Drill' },
  { value: 'match', label: 'Match' },
];
/** `selected` for "No court, just time it". */
const NO_COURT = 'none';

/** One open of the sheet. privateOnly: the consent sheet got "Not now". */
type Shown = { req: PlayStartRequest; privateOnly: boolean };

/** Mounted once at the app root: shows the sheet for each openPlayStart(). */
export default function PlayStartSheetHost({ signedIn }: { signedIn: boolean }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const signedInRef = useRef(signedIn);
  signedInRef.current = signedIn;

  const take = useCallback(() => {
    if (!signedIn) return; // kept until sign-in
    const r = takePlayStartRequest();
    if (!r) return;
    // The session was restored after the request was made: the island, not the sheet.
    if (playSession.get().status !== 'idle') {
      playIslandExpand.emit();
      return;
    }
    // First the one-time consent sheet (answers at once once accepted). Not
    // now: this sheet still opens, offering only the private timer.
    void ensurePresenceConsent().then((ok) => {
      if (!signedInRef.current) return;
      if (playSession.get().status !== 'idle') {
        playIslandExpand.emit();
        return;
      }
      setShown({ req: r, privateOnly: !ok });
    });
  }, [signedIn]);

  // A request made before this mounted (a cold start from the notice).
  useEffect(() => {
    take();
  }, [take]);
  useSignal(playStartRequested, take);
  useEffect(() => {
    if (!signedIn) setShown(null);
  }, [signedIn]);

  return (
    <PlayStartSheet
      request={shown?.req ?? null}
      privateOnly={!!shown?.privateOnly}
      onClose={() => setShown(null)}
    />
  );
}

export function PlayStartSheet({
  request,
  privateOnly = false,
  onClose,
}: {
  request: PlayStartRequest | null;
  /** Only the private timer: no court list, no location read. */
  privateOnly?: boolean;
  onClose: () => void;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);
  const [courts, setCourts] = useState<CourtCandidate[]>([]);
  // A court id, NO_COURT, or null before anything is known.
  const [selected, setSelected] = useState<string | null>(null);
  const [kind, setKind] = useState<ChipKind>('open_play');
  const [finding, setFinding] = useState(false);
  const [visibility, setVisibility] = useState<CheckinVisibility | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [offerNoCourt, setOfferNoCourt] = useState(false);
  // The fix isn't at the chosen court: "Start at <the court I'm at>" / "Start anyway".
  const [offerHere, setOfferHere] = useState<{ id: string; name: string } | null>(null);
  const [offerAnyway, setOfferAnyway] = useState(false);
  // The court at the fix taken on open (null: none there), and whether one was taken.
  const [here, setHere] = useState<ResolvedCourt | null>(null);
  const [openFix, setOpenFix] = useState(false);
  // The preselection follows the lists as they land until the player picks.
  const picked = useRef(false);
  const fixRef = useRef<DeviceFix | null>(null);
  // What resolve_court said for that fix (reused by Start for the same fix).
  const resolvedFor = useRef<{ fix: DeviceFix; court: ResolvedCourt | null } | null>(null);
  // The open request, set during render so a close counts at once: Start
  // checks it after every wait and does nothing for a sheet closed (request
  // null) or replaced by a newer open (a new object) meanwhile.
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    if (!request) return;
    let alive = true;
    picked.current = false;
    fixRef.current = null;
    resolvedFor.current = null;
    setKind(request.kind === 'drill' || request.kind === 'match' ? request.kind : 'open_play');
    setCourts([]);
    setSelected(null);
    setMessage(null);
    setOfferNoCourt(false);
    setOfferHere(null);
    setOfferAnyway(false);
    setHere(null);
    setOpenFix(false);
    setBusy(false);
    if (privateOnly) {
      // "Not now" on who sees you at the courts: the private timer only.
      setSelected(NO_COURT);
      setFinding(false);
      return;
    }

    const groups: Partial<Record<CourtReason, { id: string; name: string }[]>> = {};
    const publish = () => {
      if (!alive) return;
      const list = mergeCourtCandidates(groups);
      setCourts(list);
      if (!picked.current) setSelected(list[0]?.id ?? NO_COURT);
    };

    void peekCurrentCheckin().then((cur) => {
      if (cur) groups.checked_in = [{ id: cur.venueId, name: cur.venueName }];
      publish();
    });
    setFinding(true);
    void (async () => {
      try {
        const fix = await takeFixIfAllowed(6_000);
        if (!fix || !alive) return;
        fixRef.current = fix;
        setOpenFix(true);
        const found = await resolveCourtAt(fix.lat, fix.lng, 150);
        if (!alive) return;
        resolvedFor.current = { fix, court: found };
        setHere(found);
        if (found) groups.here = [{ id: found.id, name: found.name }];
        publish();
      } catch {
        // The usual courts still show.
      } finally {
        if (alive) setFinding(false);
      }
    })();
    void (async () => {
      const uid = await currentUserId(supabase);
      if (!uid) return;
      const [leagues, favorites, recent] = await Promise.all([
        getMyLeagueCourts(uid).catch(() => []),
        listMyCourtFavorites().catch(() => []),
        getMyRecentCourts(uid).catch(() => []),
      ]);
      const homeIds = [...new Set(leagues.map((l) => l.home_venue_id).filter((id): id is string => !!id))];
      groups.home = await getVenuesByIds(homeIds).catch(() => []);
      groups.favorite = favorites.map((f) => ({ id: f.venue_id, name: f.venue_name }));
      groups.recent = recent;
      publish();
    })();
    // Unreadable: the line falls back to the default level.
    void loadPresenceSettings()
      .then((s) => alive && setVisibility({ level: s.checkins_level, pausedUntil: s.paused_until }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [request, privateOnly]);

  const court = privateOnly ? null : (courts.find((x) => x.id === selected) ?? null);

  function clearOffers() {
    setMessage(null);
    setOfferNoCourt(false);
    setOfferHere(null);
    setOfferAnyway(false);
  }

  function pick(id: string) {
    picked.current = true;
    setSelected(id);
    clearOffers();
  }

  /**
   * Start. `anyway`: skip the "is the fix at this court" check (the player
   * chose to). `at`: start at this court instead of the selected one.
   */
  async function start(opts: { withoutCourt?: boolean; anyway?: boolean; at?: CourtCandidate } = {}) {
    const req = request;
    const sourceId = req?.sourceId ?? null;
    const at = privateOnly || opts.withoutCourt ? null : (opts.at ?? court);
    clearOffers();
    if (!at) {
      startPlay({ kind, sourceId, venueId: null, venueName: null });
      onClose();
      return;
    }
    // Closed (request null) or replaced by a newer open while we waited.
    const stale = () => requestRef.current !== req;
    setBusy(true);
    try {
      const fresh = isFixFresh(fixRef.current, Date.now(), FIX_REUSE_MS) ? fixRef.current : null;
      // My check-in's court: the server adopts that confirmed check-in, so
      // Start needs no fix there (re-read: it may have ended since the sheet
      // opened). A recent fix still goes along.
      if (at.reason === 'checked_in') {
        const cur = await peekCurrentCheckin();
        if (stale()) return;
        if (!startNeedsFix(at, cur?.venueId)) {
          startPlay({ kind, sourceId, venueId: at.id, venueName: at.name, fix: fresh });
          onClose();
          return;
        }
      }
      // The fix from opening the sheet when it is still recent, else a fresh
      // one (asking for location first, outside the fix's 6 s).
      const fix = fresh ?? ((await askForLocation()) && !stale() ? await takeCheckinFix(6_000) : null);
      if (stale()) return; // the player backed out: start nothing, share nothing
      if (!fix) {
        const reason = await noFixReason();
        if (stale()) return;
        setMessage(reason);
        setOfferNoCourt(true);
        return;
      }
      fixRef.current = fix;
      if (!opts.anyway) {
        // Is the fix at this court? resolve_court answers canonical ids, as
        // the list stores them. Never judged by `inside` (the mapped fence
        // only): the server also accepts its radius plus the fix's accuracy.
        // A failed lookup doesn't block Start; the server is the judge.
        const known = resolvedFor.current?.fix === fix ? resolvedFor.current.court : undefined;
        const found = known !== undefined ? known : await resolveCourtAt(fix.lat, fix.lng, 150).catch(() => undefined);
        if (stale()) return;
        if (found !== undefined) resolvedFor.current = { fix, court: found };
        if (found !== undefined && found?.id !== at.id) {
          setMessage(
            `You're not at ${at.name}, so nobody will see you there.${found ? ` You're at ${found.name}.` : ''}`,
          );
          setOfferHere(found ? { id: found.id, name: found.name } : null);
          setOfferNoCourt(true);
          setOfferAnyway(true);
          return;
        }
      }
      startPlay({ kind, sourceId, venueId: at.id, venueName: at.name, fix });
      onClose();
    } finally {
      if (!stale()) setBusy(false); // never clear a newer sheet's busy state
    }
  }

  /** "Start at <the court I'm at>": select it (adding it when the list lacks it) and start there. */
  function startHere(h: { id: string; name: string }) {
    const cand: CourtCandidate = { id: h.id, name: h.name, reason: 'here' };
    picked.current = true;
    setCourts((list) => (list.some((x) => x.id === h.id) ? list : [cand, ...list]));
    setSelected(h.id);
    void start({ at: cand, anyway: true });
  }

  const atCourt = atSelectedCourt(court, here, openFix);
  const line = visibilityLine(visibility, !!court, Date.now(), (iso) => whenPhrase(iso, Date.now()) ?? iso, atCourt);
  // "You're here" only inside the mapped fence; nearby but outside it, the distance.
  const noteFor = (x: CourtCandidate) =>
    x.reason === 'here' && here && here.id === x.id && !here.inside
      ? `About ${Math.round(here.distance_m)} m away`
      : courtNote(x.reason);

  return (
    <BottomSheet visible={!!request} onClose={onClose} title="Where are you playing?" contentStyle={S.content}>
      <ScrollView style={S.scroll} contentContainerStyle={S.scrollBody} keyboardShouldPersistTaps="handled">
        {courts.map((x) => (
          <CourtRow
            key={x.id}
            title={`📍 ${x.name}`}
            note={noteFor(x)}
            selected={selected === x.id}
            onPress={() => pick(x.id)}
          />
        ))}
        {finding ? (
          <View style={S.finding}>
            <ActivityIndicator size="small" color={c.primary} />
            <Text style={t.hint}>Finding the court you're at…</Text>
          </View>
        ) : null}
        <CourtRow
          title="No court, just time it"
          note="A timer only you see"
          selected={selected === NO_COURT}
          onPress={() => pick(NO_COURT)}
        />
        {privateOnly ? (
          <Text style={[t.sub, S.message]}>
            Only you see this timer. To play at a court, first choose who sees you there: you'll be asked again the
            next time you start.
          </Text>
        ) : null}

        <Text style={[t.label, S.label]}>KIND</Text>
        <SegmentedToggle options={KINDS} value={kind} onChange={setKind} size="lg" fullWidth />

        <Text style={[t.sub, S.visibility]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
          {line}
          {court ? (
            <Text
              style={{ color: c.primary }}
              onPress={() => {
                onClose();
                navigateWhenReady('Settings');
              }}
              accessibilityRole="link"
            >
              {' · Change'}
            </Text>
          ) : null}
        </Text>
        {message ? <Text style={[t.sub, S.message]}>{message}</Text> : null}
      </ScrollView>

      <View style={S.actions}>
        {offerHere ? (
          <Button
            title={`Start at ${offerHere.name}`}
            variant="outline"
            disabled={busy}
            onPress={() => startHere(offerHere)}
          />
        ) : null}
        {offerNoCourt ? (
          <Button
            title="Start without a court"
            variant="outline"
            disabled={busy}
            onPress={() => void start({ withoutCourt: true })}
          />
        ) : null}
        <Button
          title={offerAnyway ? '▶  Start anyway' : '▶  Start playing'}
          variant="success"
          loading={busy}
          disabled={busy || selected === null}
          onPress={() => void start({ anyway: offerAnyway })}
        />
      </View>
    </BottomSheet>
  );
}

function CourtRow({
  title,
  note,
  selected,
  onPress,
}: {
  title: string;
  note: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);
  return (
    <TouchableOpacity
      style={[S.row, { borderColor: selected ? c.primary : c.border, backgroundColor: selected ? c.primaryLight : c.bg }]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${title.replace('📍 ', '')}, ${note}`}
    >
      <Text style={[t.title, { color: selected ? c.primary : c.text }]} numberOfLines={1}>
        {title}
      </Text>
      <Text style={t.meta} numberOfLines={1}>
        {note}
      </Text>
    </TouchableOpacity>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    // The list scrolls inside the sheet's cap; Start stays in view below it.
    content: { minHeight: 0, flexShrink: 1 },
    scroll: { flexShrink: 1 },
    scrollBody: { gap: SPACE.sm, paddingBottom: SPACE.sm },
    row: {
      minHeight: 56,
      justifyContent: 'center',
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.sm,
      borderWidth: HAIRLINE,
      borderRadius: RADIUS.md,
      gap: SPACE.xxs,
    },
    finding: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44 },
    label: { marginTop: SPACE.md },
    visibility: { marginTop: SPACE.md },
    message: { marginTop: SPACE.sm },
    actions: { gap: SPACE.sm, paddingTop: SPACE.sm, borderTopWidth: HAIRLINE, borderTopColor: c.border },
  });
}
