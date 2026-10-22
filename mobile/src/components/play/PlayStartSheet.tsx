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
//
// With the bottom bar (PLAY_NAV_ENABLED, plan §7.2) it is the slim "▶ Play"
// sheet: one court line ("Riverside Park · Change"; the list opens only on
// Change or when no court was found), Open play · Closed group · Drill picked
// from what I have scheduled around now (lib/playStartRules pickPlayChip, with
// a "From your 6 PM routine" hint), How long, and the plan line in draft mode.
// Start starts the session, then sends the plan once its check-in exists
// (lib/playStartPlan), and never navigates. "▶ Play here" opens it with that
// court picked (request.venue). A request for a match or with a source (the
// "starting now" notice) shows that instead of the chips.
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
import { DurationChips } from '@just-messin-around/expo-foundation/ui';
import { getForegroundLocationStatus } from '@just-messin-around/expo-foundation/platform';
import { formatDurationMinutes, type TimeWindow } from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import { PLAY_NAV_ENABLED } from '../../lib/features';
import {
  PLAY_CHIP_KIND,
  PLAY_CHIP_LABEL,
  pickPlayChip,
  windowsForChip,
  type ChipDraftWindow,
  type ChipPick,
  type ChipScheduleItem,
  type PlayChip,
} from '../../lib/playStartRules';
import { loadChipRoutine, loadChipSchedule, readLastChip, saveLastChip } from '../../lib/playStartSchedule';
import { planAfterStart } from '../../lib/playStartPlan';
import { checkinAtRequested } from '../../lib/checkinHost';
import { track } from '../../lib/analytics';
import {
  DEFAULT_PLAY_LENGTH_MIN,
  clockLabel,
  fitCheckinPlanWindows,
  type PlayMode,
} from '../../lib/courtRoutineRules';
import CheckinPlanLine from '../routines/CheckinPlanLine';

/** The slim sheet's "How long" chips (plan §7.2). */
const SLIM_LENGTHS = [60, 90, 120, 180];
/** The chips, plus the current length when it is none of them (a routine's
 *  105, the plan editor's 240), so the chosen length always shows selected. */
function slimLengths(current: number): number[] {
  return SLIM_LENGTHS.includes(current) ? SLIM_LENGTHS : [...SLIM_LENGTHS, current].sort((a, b) => a - b);
}

function draftOf(list: ChipDraftWindow[]): TimeWindow<PlayMode>[] {
  return list.map((w) => ({ startMin: w.startMin, endMin: w.endMin, mode: w.mode, hint: null, group: [] }));
}

type ChipKind = Extract<PlayKind, 'open_play' | 'drill' | 'match'>;
const KINDS: { value: ChipKind; label: string }[] = [
  { value: 'open_play', label: 'Open play' },
  { value: 'drill', label: 'Drill' },
  { value: 'match', label: 'Match' },
];
/** `selected` for "No court, just time it". */
const NO_COURT = 'none';
/** The slim sheet's read-only line for a session asked for by kind (C3). */
const PLAY_KIND_LINE: Record<PlayKind, string> = {
  open_play: 'Open play',
  drill: 'Drill session',
  match: 'Match',
  event: 'Event',
};

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

  // ── The slim sheet (PLAY_NAV_ENABLED) ──
  const slim = PLAY_NAV_ENABLED;
  const [chip, setChip] = useState<PlayChip>('open');
  // A chip the player tapped stays: the auto-pick only moves an untouched one.
  const chipTouched = useRef(false);
  // The player set How long or the plan: a later re-pick (the court landing
  // after a slow fix) may still move the chip but keeps their length and plan.
  const planTouched = useRef(false);
  const [chipPick, setChipPick] = useState<ChipPick | null>(null);
  const [lengthMin, setLengthMin] = useState(DEFAULT_PLAY_LENGTH_MIN);
  const [draft, setDraft] = useState<TimeWindow<PlayMode>[]>(() => draftOf(windowsForChip('open', DEFAULT_PLAY_LENGTH_MIN, null)));
  const [showCourts, setShowCourts] = useState(false);
  const [locOff, setLocOff] = useState(false);
  const [chipInputs, setChipInputs] = useState<{ schedule: ChipScheduleItem[]; last: PlayChip | null } | null>(null);
  // A match, or a drill / match from the "starting now" notice: that, not the chips.
  const fixedKind: PlayKind | null =
    request && (request.kind === 'match' || !!request.sourceId) ? (request.kind ?? 'open_play') : null;

  useEffect(() => {
    if (!request) return;
    let alive = true;
    picked.current = false;
    fixRef.current = null;
    resolvedFor.current = null;
    chipTouched.current = false;
    planTouched.current = false;
    setChipPick(null);
    setChip(request.kind === 'drill' ? 'drill' : 'open');
    setLengthMin(DEFAULT_PLAY_LENGTH_MIN);
    setDraft(draftOf(windowsForChip(request.kind === 'drill' ? 'drill' : 'open', DEFAULT_PLAY_LENGTH_MIN, null)));
    setShowCourts(false);
    setLocOff(false);
    setChipInputs(null);
    if (slim && !privateOnly) {
      void getForegroundLocationStatus()
        .then((s) => alive && setLocOff(s === 'denied'))
        .catch(() => {});
      // A drill asked for by name stays a drill.
      if (request.kind === 'drill') chipTouched.current = true;
      void Promise.all([loadChipSchedule(Date.now()), readLastChip()]).then(
        ([schedule, last]) => alive && setChipInputs({ schedule, last }),
      );
    }
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
      if (picked.current) return;
      // The slim sheet preselects only a court it detected (my check-in, or
      // one within 150 m of a fix): a usual court I'm not at would read as
      // "you're here". Nothing detected: "No court found nearby", the list open.
      const first = list[0];
      const detected = !!first && (first.reason === 'checked_in' || first.reason === 'picked' || first.reason === 'here');
      setSelected(slim && !detected ? NO_COURT : (first?.id ?? NO_COURT));
    };
    // "▶ Play here": that court, picked (it stays picked as the lists land).
    if (request.venue) {
      groups.picked = [request.venue];
      picked.current = true;
      setSelected(request.venue.id);
      publish();
    }

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
  const courtId = court?.id ?? null;

  // The chip from what I have scheduled around now (and the routine due at
  // this court), until the player taps one. Re-picked when the court changes.
  useEffect(() => {
    if (!slim || !request || !chipInputs || fixedKind) return;
    let alive = true;
    void loadChipRoutine(courtId, new Date()).then((routine) => {
      if (!alive || chipTouched.current) return;
      const p = pickPlayChip({
        nowMs: Date.now(),
        routine,
        schedule: chipInputs.schedule,
        lastUsed: chipInputs.last,
        clock: (iso) => clockLabel(iso),
      });
      // Closed group needs a court (C2): with none, open play.
      const next: PlayChip = p.chip === 'closed' && !courtId ? 'open' : p.chip;
      // The hint explains the pick; when the chip had to change, it doesn't.
      setChipPick(next === p.chip ? p : { ...p, hint: null });
      setChip(next);
      if (planTouched.current) return;
      const len = p.lengthMin ?? DEFAULT_PLAY_LENGTH_MIN;
      setLengthMin(len);
      setDraft(draftOf(windowsForChip(next, len, p)));
    });
    return () => {
      alive = false;
    };
  }, [slim, request, chipInputs, courtId, fixedKind]);

  function chooseChip(next: PlayChip) {
    chipTouched.current = true;
    setChip(next);
    setDraft(draftOf(windowsForChip(next, lengthMin, chipPick)));
  }

  function chooseLength(n: number) {
    planTouched.current = true;
    setLengthMin(n);
    setDraft((w) => (w.length > 0 ? fitCheckinPlanWindows(w, n) : w));
  }

  /** "Allow location" / "Find my court": ask, take a fix, and pick the court I'm at. */
  async function findMyCourt() {
    const req = request;
    setFinding(true);
    try {
      const ok = await askForLocation();
      if (requestRef.current !== req) return;
      setLocOff(!ok);
      if (!ok) return;
      const fix = await takeCheckinFix(6_000);
      if (!fix || requestRef.current !== req) return;
      fixRef.current = fix;
      setOpenFix(true);
      const found = await resolveCourtAt(fix.lat, fix.lng, 150).catch(() => null);
      if (requestRef.current !== req) return;
      resolvedFor.current = { fix, court: found };
      setHere(found);
      if (found) {
        setCourts((list) => (list.some((x) => x.id === found.id) ? list : [{ id: found.id, name: found.name, reason: 'here' }, ...list]));
        if (!picked.current || selected === NO_COURT) setSelected(found.id);
        setShowCourts(false);
      } else {
        setShowCourts(true);
      }
    } finally {
      if (requestRef.current === req) setFinding(false);
    }
  }

  /** Start the session (and, at a court, send the plan once its check-in exists). */
  function launch(m: { venueId: string | null; venueName: string | null; fix?: DeviceFix | null; viaCheckin?: boolean }) {
    const sourceId = request?.sourceId ?? null;
    const k: PlayKind = slim ? (fixedKind ?? PLAY_CHIP_KIND[chip].kind) : kind;
    const id = startPlay({ kind: k, sourceId, ...m });
    if (slim && !fixedKind) {
      saveLastChip(chip);
      if (m.venueId) planAfterStart(id, { venueId: m.venueId, lengthMin, windows: draft });
      track('play.start_sheet', { chip, why: chipPick?.why ?? 'default', court: !!m.venueId, length_min: lengthMin });
    }
    onClose();
  }

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
    setShowCourts(false);
    // No court: nobody sees a closed group.
    if (id === NO_COURT && chip === 'closed') chooseChip('open');
  }

  /**
   * Start. `anyway`: skip the "is the fix at this court" check (the player
   * chose to). `at`: start at this court instead of the selected one.
   */
  async function start(opts: { withoutCourt?: boolean; anyway?: boolean; at?: CourtCandidate } = {}) {
    const req = request;
    const at = privateOnly || opts.withoutCourt ? null : (opts.at ?? court);
    clearOffers();
    if (!at) {
      launch({ venueId: null, venueName: null });
      return;
    }
    // Closed (request null) or replaced by a newer open while we waited.
    const stale = () => requestRef.current !== req;
    setBusy(true);
    try {
      const fresh = isFixFresh(fixRef.current, Date.now(), FIX_REUSE_MS) ? fixRef.current : null;
      // My check-in's court: the server adopts that confirmed check-in, so
      // Start needs no fix there (re-read: it may have ended since the sheet
      // opened). A recent fix still goes along. A private check-in (saved
      // without a fix by an older build) is never adopted: it needs the fix.
      // viaCheckin: if the check-in turns out to be gone, the island says
      // that, not "couldn't get your location".
      if (at.reason === 'checked_in') {
        const cur = await peekCurrentCheckin();
        if (stale()) return;
        if (!startNeedsFix(at, cur && !cur.private ? cur.venueId : null)) {
          launch({ venueId: at.id, venueName: at.name, fix: fresh, viaCheckin: true });
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
      launch({ venueId: at.id, venueName: at.name, fix });
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

  if (slim) {
    const list = (
      <>
        {courts.map((x) => (
          <CourtRow
            key={x.id}
            title={`📍 ${x.name}`}
            note={noteFor(x)}
            selected={selected === x.id}
            onPress={() => pick(x.id)}
          />
        ))}
        <CourtRow
          title="No court, just time it"
          note="A timer only you see"
          selected={selected === NO_COURT}
          onPress={() => pick(NO_COURT)}
        />
      </>
    );
    const chips = (court ? (['open', 'closed', 'drill'] as PlayChip[]) : (['open', 'drill'] as PlayChip[])).map((v) => ({
      value: v,
      label: PLAY_CHIP_LABEL[v],
    }));
    // "No court" the player chose, vs. none detected (the list opens then).
    const choseNoCourt = selected === NO_COURT && picked.current;
    const noCourtFound = !finding && !court && !choseNoCourt;
    const courtsOpen = showCourts || privateOnly || noCourtFound;
    return (
      <BottomSheet visible={!!request} onClose={onClose} title="▶ Play" contentStyle={S.content}>
        <ScrollView style={S.scroll} contentContainerStyle={S.scrollBody} keyboardShouldPersistTaps="handled">
          <Text style={t.sub}>Times your play and checks you in, so friends can find you.</Text>

          {/* The court line: the detected court, or why there's none. */}
          {privateOnly ? null : (
            <View style={S.courtLine}>
              <Text style={[t.title, S.flex]} numberOfLines={2}>
                {'📍 '}
                {court ? (
                  <>
                    {court.name}
                    <Text style={[t.meta, { color: c.textSub }]}>{`  ${noteFor(court)}`}</Text>
                  </>
                ) : choseNoCourt ? (
                  'No court'
                ) : finding ? (
                  'Finding your court…'
                ) : locOff ? (
                  'Location is off'
                ) : (
                  'No court found nearby'
                )}
              </Text>
              {finding && !court ? <ActivityIndicator size="small" color={c.primary} /> : null}
              <TouchableOpacity
                style={S.link}
                onPress={() => setShowCourts((x) => !x)}
                accessibilityRole="button"
                accessibilityLabel={court ? `Change court, ${court.name}` : 'Pick a court'}
              >
                <Text style={[t.meta, { color: c.primary }]}>{court ? 'Change' : 'Pick a court'}</Text>
              </TouchableOpacity>
            </View>
          )}
          {!privateOnly && !finding && !openFix && !here ? (
            // Location off, or never asked (Safari may never say "allowed"):
            // asked only on this tap, as the court card did.
            <TouchableOpacity style={S.linkLeft} onPress={() => void findMyCourt()} accessibilityRole="button">
              <Text style={[t.meta, { color: c.primary }]}>{locOff ? 'Allow location' : 'Find my court'}</Text>
            </TouchableOpacity>
          ) : null}
          {courtsOpen ? <View style={S.list}>{list}</View> : null}
          {privateOnly ? (
            <Text style={[t.sub, S.message]}>
              Only you see this timer. To play at a court, first choose who sees you there: you'll be asked again the
              next time you start.
            </Text>
          ) : null}

          <Text style={[t.label, S.label]}>HOW ARE YOU PLAYING</Text>
          {fixedKind ? (
            <Text style={t.body}>{PLAY_KIND_LINE[fixedKind]}</Text>
          ) : (
            <>
              <SegmentedToggle options={chips} value={chip} onChange={chooseChip} size="lg" fullWidth />
              {chipPick?.hint && !chipTouched.current ? <Text style={[t.hint, S.hint]}>{chipPick.hint}</Text> : null}
            </>
          )}

          {/* How long and the plan set the check-in: none without a court. */}
          {!fixedKind && court ? (
            <>
              <Text style={[t.label, S.label]}>HOW LONG</Text>
              <DurationChips value={lengthMin} onChange={chooseLength} options={slimLengths(lengthMin)} format={formatDurationMinutes} />
              {court ? (
                <CheckinPlanLine
                  checkinId={null}
                  style={S.plan}
                  draft={{
                    lengthMin,
                    windows: draft,
                    onChange: (len, w) => {
                      planTouched.current = true;
                      setLengthMin(len);
                      setDraft(w);
                    },
                  }}
                />
              ) : null}
            </>
          ) : null}

          {court && atCourt === true ? (
            <View style={[S.visibility, S.visibilityRow]}>
              <Text style={[t.sub, S.flex]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {line}
              </Text>
              <TouchableOpacity
                style={S.link}
                onPress={() => {
                  onClose();
                  navigateWhenReady('Settings');
                }}
                accessibilityRole="button"
                accessibilityLabel="Change who sees you"
              >
                <Text style={[t.sub, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                  Change
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {message ? <Text style={[t.sub, S.message]}>{message}</Text> : null}
        </ScrollView>

        <View style={S.actions}>
          {offerHere ? (
            <Button title={`Start at ${offerHere.name}`} variant="outline" disabled={busy} onPress={() => startHere(offerHere)} />
          ) : null}
          {offerNoCourt ? (
            <Button title="Start without a court" variant="outline" disabled={busy} onPress={() => void start({ withoutCourt: true })} />
          ) : null}
          <Button
            // No court detected and none picked: Start only times the play
            // (no check-in), so the button says so.
            title={offerAnyway ? '▶  Start anyway' : !court && !privateOnly ? '▶  Start without a court' : '▶  Start playing'}
            variant="success"
            loading={busy}
            disabled={busy || selected === null}
            onPress={() => void start({ anyway: offerAnyway })}
          />
          <View style={S.footer}>
            {court && !privateOnly ? (
              <TouchableOpacity
                style={S.link}
                disabled={busy}
                onPress={() => {
                  const v = { id: court.id, name: court.name };
                  onClose();
                  checkinAtRequested.emit(v);
                }}
                accessibilityRole="button"
              >
                <Text style={[t.meta, { color: c.primary }]}>Just check in</Text>
              </TouchableOpacity>
            ) : null}
            {selected !== NO_COURT && !privateOnly ? (
              <TouchableOpacity
                style={S.link}
                disabled={busy}
                onPress={() => void start({ withoutCourt: true })}
                accessibilityRole="button"
              >
                <Text style={[t.meta, { color: c.textSub }]}>No court, just time it</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </BottomSheet>
    );
  }

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
    visibilityRow: { flexDirection: 'row', alignItems: 'center', columnGap: SPACE.xs },
    message: { marginTop: SPACE.sm },
    actions: { gap: SPACE.sm, paddingTop: SPACE.sm, borderTopWidth: HAIRLINE, borderTopColor: c.border },
    // The slim sheet.
    courtLine: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 44, marginTop: SPACE.xs },
    flex: { flex: 1, minWidth: 0 },
    link: { minHeight: 44, minWidth: 44, paddingHorizontal: SPACE.xs, alignItems: 'center', justifyContent: 'center' },
    linkLeft: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
    list: { gap: SPACE.sm },
    hint: { marginTop: SPACE.xs },
    plan: { marginTop: SPACE.sm },
    footer: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', columnGap: SPACE.md },
  });
}
