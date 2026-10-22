// Settings > Check-in automation (state/court-arrival-doggle-parity.md section
// F): Doggle's FavoriteCheckinSettingsPanel without walks (routines: "At your
// routine courts", ROUTINES_ENABLED). At starred courts Pickleague can check
// you in when you arrive; everywhere else it only sends prompts.
//
// The settings are per account (get_court_arrival_settings, and the
// per-court switch on court_favorites), so a second phone and the web show
// the same choices; the geofences themselves run on the phone only.
//
// Every change: the RPC, the cache write (data/courtArrival does it), a
// resync of the watched courts (courtArrivalResync, which CourtArrivalHost
// acts on), a toast. While one change is saving, every control is disabled.
// The per-court switch patches what the geofence wakes read instead of
// resyncing (the circles don't change).
//
// "Always" location is asked for only by Allow here, never on open (D2).
import React, { useCallback, useEffect, useState } from 'react';
import { AccessibilityInfo, AppState, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { peekQuery, setQueryData, useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { Button } from '@just-messin-around/expo-foundation/forms';
import {
  LoadingState,
  Panel,
  SectionHeader,
  SettingChoiceRow,
  SettingSwitchRow,
  type SegmentedOption,
} from '@just-messin-around/expo-foundation/ui';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { HAIRLINE, SPACE } from '@just-messin-around/expo-foundation/styles';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { explainRefusal } from '../lib/refusalNotices';
import CourtPicker, { type CourtResult } from './CourtPicker';
import RoutineSettingsSection from './routines/RoutineSettingsSection';
import {
  COURT_ARRIVAL_PERSIST_MS,
  COURT_ARRIVAL_SETTINGS_KEY,
  COURT_ARRIVAL_SETTINGS_TTL_MS,
  courtArrivalResync,
  getCourtArrivalSettings,
  listStarredCourtGeofences,
  setCourtArrivalSettings,
  setStarredCourtAutoCheckin,
  STARRED_COURT_GEOFENCES_KEY,
  STARRED_COURT_GEOFENCES_TTL_MS,
} from '../data/courtArrival';
import { isCourtFavoritesFullError, toggleCourtFavorite, useCourtFavorites } from '../data/courtFavorites';
import { useReplaceCourtStar } from './court/useReplaceCourtStar';
import { COURT_RADIUS_CHOICES, type StarredCourtGeofence } from '../lib/courtArrivalRules';
import { dropWaitingArrivalNotices } from '../lib/courtArrivalNotice';
import { patchCourtRegionInfo } from '../lib/courtGeofence';
import {
  ALWAYS_LABEL,
  arrivalSyncMessage,
  askForArrivalLocation,
  backgroundLocationAllowed,
  courtStarsChanged,
  NOTICE_ME_OFF_NOTE,
  noticeMeOff,
} from '../lib/courtArrivalAsk';

const NATIVE = Platform.OS !== 'web';
/** The geofences are the phone's: a web change takes effect there. */
const PHONE_ONLY_NOTE = 'Applies on your phone.';
const UPDATE_FAILED = 'Could not update setting';

function radiusLabel(m: number): string {
  if (m <= 0) return 'Off';
  return m >= 1000 ? `${m / 1000} km` : `${m} m`;
}

const RADIUS_OPTIONS: SegmentedOption<number>[] = COURT_RADIUS_CHOICES.map((m) => ({ value: m, label: radiusLabel(m) }));

type Colors = ReturnType<typeof useTheme>['colors'];

/**
 * "Background location: Allowed / Not allowed", with Allow (the OS sheets,
 * then the watched courts again) and what that came to. Native only. Re-read
 * when the app comes back, since the change is made in the phone's Settings.
 * Top level, not inside the panel: a nested component would remount on every
 * render.
 */
function BackgroundLocationRow({ busy, setBusy }: { busy: boolean; setBusy: (b: boolean) => void }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  // Allow's own spinner: `busy` is the whole panel's, and another setting
  // saving must not look like the OS sheet is up.
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const recheck = useCallback(() => {
    void backgroundLocationAllowed().then(setAllowed);
  }, []);
  useEffect(() => {
    recheck();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') recheck();
    });
    return () => sub.remove();
  }, [recheck]);

  // Not bounded: the player may sit on the OS sheet.
  async function allow() {
    setBusy(true);
    setAsking(true);
    setResult(null);
    try {
      const r = await askForArrivalLocation();
      // With stars but "Notice me" Off nothing is watched ('stopped'): say
      // that switch is what to change, not "Star a court first".
      const m = arrivalSyncMessage(r, { noticeOff: noticeMeOff() });
      setResult(m);
      // The result line is a live region on Android; iOS has none, so say it.
      if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(m.message);
      recheck();
    } finally {
      setAsking(false);
      setBusy(false);
    }
  }

  if (allowed === null) return null;
  return (
    <Panel padded={false} style={S.statusPanel}>
      <View style={S.statusRow}>
        <Text style={[t.title, S.flex]}>Background location: {allowed ? 'Allowed' : 'Not allowed'}</Text>
        {allowed ? null : <Button title="Allow" size="sm" onPress={() => void allow()} loading={asking} disabled={busy} />}
      </View>
      {/* Always mounted, so a screen reader hears the result when it appears. */}
      <View aria-live="polite">
        {result ? (
          <Text style={[t.meta, S.statusResult, { color: result.ok ? c.textSub : c.danger }]}>{result.message}</Text>
        ) : null}
      </View>
    </Panel>
  );
}

/**
 * The per-court switches, under "Check me in when I arrive", each with its ★
 * to unstar the court, and Star a court. Off for a court: arriving there asks
 * first. Top level for the same reason as above.
 */
function StarredCourtSwitches({ busy, setBusy, c }: { busy: boolean; setBusy: (b: boolean) => void; c: Colors }) {
  const t = textStyles(c);
  const toast = useToast();
  // The raw fetcher: data/courtArrival's loadStarredCourtGeofences wraps this
  // same key in cachedFetch, and a hook bound to that would wait on itself.
  const query = useCachedQuery(STARRED_COURT_GEOFENCES_KEY, listStarredCourtGeofences, {
    ttlMs: STARRED_COURT_GEOFENCES_TTL_MS,
    persistMs: COURT_ARRIVAL_PERSIST_MS,
  });
  const courts = query.data;
  // Star a court patches this list before the write and checks the 3-court cap
  // against it, so it's loaded here too (Home usually has it already).
  useCourtFavorites();
  // A 4th star offers to replace one of the 3 (Doggle's "Replace a favorite?").
  const { offerReplace, sheet } = useReplaceCourtStar();
  // The court mid-save, with the value its switch shows meanwhile.
  const [saving, setSaving] = useState<{ id: string; on: boolean } | null>(null);
  const [picking, setPicking] = useState(false);

  async function toggle(court: StarredCourtGeofence, on: boolean) {
    setBusy(true);
    setSaving({ id: court.venue_id, on });
    try {
      // Patches the cached list (and drops a court that's no longer starred).
      const saved = await setStarredCourtAutoCheckin(court.venue_id, on);
      if (!saved) {
        toast.error(`${court.name} isn't one of your starred courts anymore.`);
        // Unstarred elsewhere: stop watching it now rather than at the next open.
        courtArrivalResync.emit();
        return;
      }
      // What a geofence wake reads, so the next arrival there already knows.
      void patchCourtRegionInfo(court.venue_id, { autoCheckin: on });
      // An "At X?" up now, and the phone's own "Checked in" for an arrival
      // still waiting there, promise a check-in that won't happen any more.
      if (!on) void dropWaitingArrivalNotices(court.venue_id);
      toast.success(on ? `We'll check you in at ${court.name}` : `We'll ask first at ${court.name}`);
    } catch (e) {
      toast.error(friendlySbMessage(e, UPDATE_FAILED));
    } finally {
      setSaving(null);
      setBusy(false);
    }
  }

  // Unstarring is here too: a court starred by mistake must not need a trip
  // to the court, where the card's star is.
  async function unstar(court: StarredCourtGeofence) {
    setBusy(true);
    try {
      await toggleCourtFavorite(court.venue_id, false, court.name);
      // Off the list now; the read courtStarsChanged starts confirms it.
      const list = peekQuery<StarredCourtGeofence[]>(STARRED_COURT_GEOFENCES_KEY);
      if (list) setQueryData(STARRED_COURT_GEOFENCES_KEY, list.filter((x) => x.venue_id !== court.venue_id));
      // The server skips an arrival still waiting there now.
      void dropWaitingArrivalNotices(court.venue_id);
      courtStarsChanged();
      toast.success(`${court.name} is off your courts.`);
    } catch (e) {
      toast.error(
        explainRefusal(e, "Couldn't change your courts just now. Try again.", { action: 'favorite', venueName: court.name }),
      );
    } finally {
      setBusy(false);
    }
  }

  // Catalog courts only: a GPS spot or pasted coordinates has no court row to star.
  async function star(pick: CourtResult | null) {
    if (!pick) return;
    const id = pick.catalogId;
    if (!id) {
      toast.error('Pick a court from the list. Only courts already in Pickleague can be starred.');
      return;
    }
    if (courts?.some((x) => x.venue_id === id)) {
      setPicking(false);
      toast.success(`${pick.name} is already starred.`);
      return;
    }
    setBusy(true);
    try {
      // Past 3 this throws "You can star up to 3 courts. ...": offer to replace one.
      await toggleCourtFavorite(id, true, pick.name);
      courtStarsChanged();
      setPicking(false);
      toast.success(`${pick.name} is one of your courts now.`);
    } catch (e) {
      if (isCourtFavoritesFullError(e)) {
        const shown = await offerReplace(id, pick.name, (replaced) => {
          if (replaced) setPicking(false);
        }).catch(() => false);
        if (shown) return;
      }
      toast.error(explainRefusal(e, "Couldn't star that court. Try again.", { action: 'favorite', venueName: pick.name }));
    } finally {
      setBusy(false);
    }
  }

  const starButton = picking ? (
    <View style={S.picker}>
      <CourtPicker value={null} onSelect={(v) => void star(v)} active={picking} placeholder="Search for a court..." />
      <Button title="Cancel" size="sm" variant="outline" onPress={() => setPicking(false)} disabled={busy} style={S.hug} />
    </View>
  ) : (
    <Button
      title="Star a court"
      size="sm"
      variant="outline"
      iconName="star-outline"
      onPress={() => setPicking(true)}
      disabled={busy}
      style={[S.hug, S.starButton]}
    />
  );

  // Loading shows nothing (as in Doggle); a failure with nothing saved says so.
  if (!courts) {
    return query.loading ? null : (
      <View style={S.inset}>
        <Text style={[t.meta, S.listHead]}>Couldn't load your starred courts.</Text>
        {starButton}
        {sheet}
      </View>
    );
  }
  return (
    <View>
      <Text style={[t.meta, S.listHead, S.inset]}>
        {courts.length === 0 ? 'Star a court to choose it here.' : 'Turn a court off and we ask first there instead.'}
      </Text>
      {courts.map((court) => (
        <React.Fragment key={court.venue_id}>
          <View style={[S.divider, { backgroundColor: c.border }]} />
          <View style={S.courtRow}>
            <SettingSwitchRow
              label={court.name}
              value={saving?.id === court.venue_id ? saving.on : court.auto_checkin}
              onChange={(on) => void toggle(court, on)}
              disabled={busy}
              accessibilityLabel={`Check me in when I arrive at ${court.name}`}
              style={S.flex}
            />
            <TouchableOpacity
              style={[S.unstar, busy && S.dim]}
              onPress={() => void unstar(court)}
              disabled={busy}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              accessibilityLabel={`Remove ${court.name} from your courts`}
            >
              <Text style={[S.unstarGlyph, { color: c.warning }]}>★</Text>
            </TouchableOpacity>
          </View>
        </React.Fragment>
      ))}
      <View style={S.inset}>{starButton}</View>
      {sheet}
    </View>
  );
}

export default function CourtArrivalSettingsPanel() {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  // The raw fetcher, for the reason given above (loadCourtArrivalSettings).
  const query = useCachedQuery(COURT_ARRIVAL_SETTINGS_KEY, getCourtArrivalSettings, {
    ttlMs: COURT_ARRIVAL_SETTINGS_TTL_MS,
    persistMs: COURT_ARRIVAL_PERSIST_MS,
  });
  const s = query.data ?? null;
  const [busy, setBusy] = useState(false);

  async function apply(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await fn();
      courtArrivalResync.emit();
      toast.success(msg);
    } catch (e) {
      toast.error(friendlySbMessage(e, UPDATE_FAILED));
    } finally {
      setBusy(false);
    }
  }

  const radiusOff = !!s && s.court_radius_m <= 0;

  return (
    <View style={S.wrap}>
      <Text style={t.sub}>
        Needs Location Services on. At your starred courts we can check you in when you arrive; everywhere else we only
        send prompts.
      </Text>

      {NATIVE ? <BackgroundLocationRow busy={busy} setBusy={setBusy} /> : null}

      {query.loading ? (
        <LoadingState label="Loading settings…" />
      ) : !s ? (
        <View>
          <Text style={[t.sub, { color: c.danger }]}>
            {friendlySbMessage(query.error, "Couldn't load your check-in settings.")}
          </Text>
          <Button title="Try again" size="sm" variant="outline" onPress={() => void query.refresh()} style={[S.hug, S.retry]} />
        </View>
      ) : (
        <>
          <SectionHeader
            icon="star"
            title="At your starred courts"
            hint={`Background detection needs "${ALWAYS_LABEL}" location permission.`}
          />
          <Panel padded={false} style={S.group}>
            <SettingChoiceRow
              label="Notice me at starred courts"
              hint="How close to a starred court (one with no mapped outline) counts as being there. Off stops check-ins and nudges at starred courts."
              options={RADIUS_OPTIONS}
              value={s.court_radius_m}
              onChange={(m) =>
                void apply(async () => {
                  await setCourtArrivalSettings({ radiusM: m });
                  // Off stops arrival check-ins at starred courts: one still
                  // waiting is skipped, so its notices would promise one.
                  if (m <= 0) void dropWaitingArrivalNotices();
                }, `Set to ${radiusLabel(m)}`)
              }
              disabled={busy}
            />
            <View style={[S.divider, { backgroundColor: c.border }]} />
            <SettingSwitchRow
              label="Check me in when I arrive"
              hint={'Stay at a starred court for a minute and we check you in. As you arrive, your lock screen asks "At the courts?" with Check in now and Not here. Leave within 5 minutes and it doesn\'t count. Off: we ask first.'}
              value={s.auto_checkin}
              onChange={(on) =>
                void apply(async () => {
                  await setCourtArrivalSettings({ auto: on });
                  // Every "At X?" up now, and the phone's own "Checked in" for
                  // an arrival still waiting, promise a check-in that won't happen.
                  if (!on) void dropWaitingArrivalNotices();
                }, on ? 'Starred-court check-ins on' : 'Starred-court check-ins off')
              }
              disabled={busy || radiusOff}
              footnote={radiusOff ? NOTICE_ME_OFF_NOTE : NATIVE ? undefined : PHONE_ONLY_NOTE}
              accessibilityLabel="Check me in when I arrive at a starred court"
            />
            {!radiusOff && s.auto_checkin ? <StarredCourtSwitches busy={busy} setBusy={setBusy} c={c} /> : null}
            <View style={[S.divider, { backgroundColor: c.border }]} />
            <SettingSwitchRow
              label="Remind me to check out when I leave"
              hint="When you leave a starred court while still checked in, we'll ask if you want to check out. Check-ins otherwise end on their own (tap Stay 1 more hour for more time)."
              value={s.departure_reminder}
              onChange={(on) =>
                void apply(
                  () => setCourtArrivalSettings({ departure: on }),
                  on ? 'Check-out reminders on' : 'Check-out reminders off',
                )
              }
              disabled={busy || radiusOff}
              footnote={radiusOff ? NOTICE_ME_OFF_NOTE : NATIVE ? undefined : PHONE_ONLY_NOTE}
            />
            <View style={[S.divider, { backgroundColor: c.border }]} />
            <SettingChoiceRow
              label="Prompt me near other courts"
              hint="Get a check-in nudge near any court, not just starred ones."
              warn="Can get spammy where there are lots of courts nearby — off by default."
              options={RADIUS_OPTIONS}
              value={s.other_court_radius_m}
              onChange={(m) => void apply(() => setCourtArrivalSettings({ otherRadiusM: m }), `Set to ${radiusLabel(m)}`)}
              disabled={busy}
            />
          </Panel>
          <RoutineSettingsSection />
        </>
      )}
    </View>
  );
}

const S = StyleSheet.create({
  wrap: { gap: SPACE.sm },
  flex: { flex: 1, minWidth: 0 },
  hug: { alignSelf: 'flex-start' },
  statusPanel: { overflow: 'hidden' },
  // A settings row: 44 tall, the button beside the words.
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
    paddingVertical: SPACE.sm,
    paddingHorizontal: SPACE.md,
    minHeight: 44,
  },
  statusResult: { paddingHorizontal: SPACE.md, paddingBottom: SPACE.sm },
  retry: { marginTop: SPACE.sm },
  group: { overflow: 'hidden' },
  divider: { height: HAIRLINE, marginHorizontal: SPACE.md },
  inset: { paddingHorizontal: SPACE.md },
  listHead: { paddingTop: SPACE.xs, paddingBottom: SPACE.xs },
  starButton: { marginTop: SPACE.xs, marginBottom: SPACE.sm },
  picker: { gap: SPACE.sm, paddingBottom: SPACE.sm },
  courtRow: { flexDirection: 'row', alignItems: 'center' },
  // The ★ beside a court's switch, in its own 44 box (as CourtFavoriteStar).
  unstar: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginRight: SPACE.xs },
  unstarGlyph: { fontSize: FONT.size.h2, lineHeight: FONT.size.h1 },
  dim: { opacity: 0.5 },
});
