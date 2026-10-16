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
// what checks me in there (no manual check-ins). No fix means no presence, so
// the sheet says so and offers to start without a court. "No court, just time
// it" is a private timer.
//
// The host is mounted once at the app root next to PlayIsland
// (navigation/AppNavigator), outside the navigator, so it navigates through
// navigateWhenReady.
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
import { FRIENDS_AT_COURTS_ENABLED } from '../../lib/features';
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
  courtNote,
  mergeCourtCandidates,
  visibilityLine,
  type CourtCandidate,
  type CourtReason,
} from '../../lib/playStartCourts';
import {
  getMyCheckinVisibility,
  type CheckinVisibility,
  getMyFavoriteCourts,
  getMyLeagueCourts,
  getMyRecentCourts,
  getVenuesByIds,
  resolveCourtAt,
} from '../../data/venueCheckins';
import type { PlayKind } from '../../data/playSessions';

type ChipKind = Extract<PlayKind, 'open_play' | 'drill' | 'match'>;
const KINDS: { value: ChipKind; label: string }[] = [
  { value: 'open_play', label: 'Open play' },
  { value: 'drill', label: 'Drill' },
  { value: 'match', label: 'Match' },
];
/** `selected` for "No court, just time it". */
const NO_COURT = 'none';

/** Mounted once at the app root: shows the sheet for each openPlayStart(). */
export default function PlayStartSheetHost({ signedIn }: { signedIn: boolean }) {
  const [request, setRequest] = useState<PlayStartRequest | null>(null);

  const take = useCallback(() => {
    if (!signedIn) return; // kept until sign-in
    const r = takePlayStartRequest();
    if (!r) return;
    // The session was restored after the request was made: the island, not the sheet.
    if (playSession.get().status !== 'idle') {
      playIslandExpand.emit();
      return;
    }
    setRequest(r);
  }, [signedIn]);

  // A request made before this mounted (a cold start from the notice).
  useEffect(() => {
    take();
  }, [take]);
  useSignal(playStartRequested, take);
  useEffect(() => {
    if (!signedIn) setRequest(null);
  }, [signedIn]);

  return <PlayStartSheet request={request} onClose={() => setRequest(null)} />;
}

export function PlayStartSheet({ request, onClose }: { request: PlayStartRequest | null; onClose: () => void }) {
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
  // The preselection follows the lists as they land until the player picks.
  const picked = useRef(false);
  const fixRef = useRef<DeviceFix | null>(null);

  useEffect(() => {
    if (!request) return;
    let alive = true;
    picked.current = false;
    fixRef.current = null;
    setKind(request.kind === 'drill' || request.kind === 'match' ? request.kind : 'open_play');
    setCourts([]);
    setSelected(null);
    setMessage(null);
    setOfferNoCourt(false);
    setBusy(false);

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
        const here = await resolveCourtAt(fix.lat, fix.lng, 150);
        if (here) groups.here = [{ id: here.id, name: here.name }];
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
        getMyFavoriteCourts(),
        getMyRecentCourts(uid).catch(() => []),
      ]);
      const homeIds = [...new Set(leagues.map((l) => l.home_venue_id).filter((id): id is string => !!id))];
      groups.home = await getVenuesByIds(homeIds).catch(() => []);
      groups.favorite = favorites.map((f) => ({ id: f.venue_id, name: f.venue_name }));
      groups.recent = recent;
      publish();
    })();
    void getMyCheckinVisibility().then((v) => alive && setVisibility(v));
    return () => {
      alive = false;
    };
  }, [request]);

  const court = courts.find((x) => x.id === selected) ?? null;

  function pick(id: string) {
    picked.current = true;
    setSelected(id);
    setMessage(null);
    setOfferNoCourt(false);
  }

  async function start(withoutCourt = false) {
    const sourceId = request?.sourceId ?? null;
    const at = withoutCourt ? null : court;
    setMessage(null);
    setOfferNoCourt(false);
    if (!at) {
      startPlay({ kind, sourceId, venueId: null, venueName: null });
      onClose();
      return;
    }
    setBusy(true);
    try {
      if (!(await ensurePresenceConsent())) return;
      // The fix from opening the sheet when it is still recent, else a fresh
      // one (asking for location first, outside the fix's 6 s).
      const fix = isFixFresh(fixRef.current, Date.now(), FIX_REUSE_MS)
        ? fixRef.current
        : (await askForLocation()) ? await takeCheckinFix(6_000) : null;
      if (!fix) {
        setMessage(await noFixReason());
        setOfferNoCourt(true);
        return;
      }
      startPlay({ kind, sourceId, venueId: at.id, venueName: at.name, fix });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const line = visibilityLine(visibility, !!court, Date.now(), (iso) => whenPhrase(iso, Date.now()) ?? iso);

  return (
    <BottomSheet visible={!!request} onClose={onClose} title="Where are you playing?" contentStyle={S.content}>
      <ScrollView style={S.scroll} contentContainerStyle={S.scrollBody} keyboardShouldPersistTaps="handled">
        {courts.map((x) => (
          <CourtRow
            key={x.id}
            title={`📍 ${x.name}`}
            note={courtNote(x.reason)}
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

        <Text style={[t.label, S.label]}>KIND</Text>
        <SegmentedToggle options={KINDS} value={kind} onChange={setKind} size="lg" fullWidth />

        <Text style={[t.sub, S.visibility]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
          {line}
          {court && FRIENDS_AT_COURTS_ENABLED ? (
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
        {offerNoCourt ? (
          <Button title="Start without a court" variant="outline" disabled={busy} onPress={() => void start(true)} />
        ) : null}
        <Button
          title="▶  Start playing"
          variant="success"
          loading={busy}
          disabled={busy || selected === null}
          onPress={() => void start()}
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
