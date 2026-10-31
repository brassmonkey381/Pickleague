// My routine (Doggle's RoutinesScreen): routine check-ins at my starred
// courts, each with today's and tomorrow's occurrences (Skip / Undo / Change
// today's time), Pause / Resume, suggestions from my check-ins, and "Check
// me in at my routine courts". Reached from Profile ("My routine") and from
// Settings > Check-in automation ("Manage my routine"). Registered only with
// ROUTINES_ENABLED. Kept short on purpose: the time first, one line each.
//
// A routine at a court no longer starred stays, dormant (no occurrences, no
// arrival check-in), and says so: star the court again to turn it back on.
import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { LoadingState, Panel, SectionHeader, SettingSwitchRow, SingleSelectModal } from '@just-messin-around/expo-foundation/ui';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import {
  WEEKDAYS_MASK,
  clockTimes,
  formatClockTime,
  formatWeekdayMask,
  localDateIn,
  maskHas,
  minutesToClock,
  wallClockIn,
  zonedClockToDate,
  zoneSuffix,
} from '@just-messin-around/expo-foundation/scheduling/weekdayMask';
import { formatDurationMinutes } from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { explainRefusal } from '../lib/refusalNotices';
import {
  DEFAULT_PLAY_LENGTH_MIN,
  DEFAULT_ROUTINE_TIME,
  routineTimeLine,
  routineWindowsLine,
  routineWindowsToSave,
  type CourtRoutine,
  type RoutineOccurrence,
  type RoutineSuggestion,
} from '../lib/courtRoutineRules';
import {
  COURT_ROUTINE_SETTINGS_KEY,
  MY_COURT_ROUTINES_KEY,
  MY_COURT_ROUTINES_PERSIST_MS,
  MY_COURT_ROUTINES_TTL_MS,
  deleteCourtRoutine,
  fetchMyCourtRoutines,
  getCourtRoutineSettings,
  loadRoutineSuggestions,
  moveRoutineOccurrence,
  saveCourtRoutine,
  setCourtRoutineActive,
  setRoutineAutoCheckin,
  skipRoutineOccurrence,
  unskipRoutineOccurrence,
  autoShareOf,
  setAutoShareRoutines,
} from '../data/courtRoutines';
import { AutoShareSettingRow } from '@just-messin-around/expo-foundation/plans';
import { CHECKIN_PLANS_ENABLED, PLAN_SHARING_ENABLED } from '../lib/features';
import { PL_AUTO_SHARE_COPY, autoShareToggledMessage } from '../lib/planSharing';

/** Plan sharing's "Share my routine stops automatically" shows here too. */
const sharing = PLAN_SHARING_ENABLED && CHECKIN_PLANS_ENABLED;
import { useCourtFavorites } from '../data/courtFavorites';
import { listMyFriends } from '../data/friends';
import type { FriendRow } from '../lib/friendship';
import RoutineEditSheet, { type RoutineDraft } from '../components/routines/RoutineEditSheet';
import { ROUTINE_DISMISSED_KEY, routineSuggestionKey } from '../components/routines/RoutineSuggestionCard';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Routines'>;

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

/** An occurrence's time on this device's clock (it matches dayLabel). */
function timeLabel(iso: string, fallback: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return formatClockTime(fallback);
  return formatClockTime(`${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`);
}

function occurrencesOf(r: CourtRoutine): RoutineOccurrence[] {
  const list = r.occurrences.length ? r.occurrences : r.next ? [r.next] : [];
  return [...list].sort((a, b) => a.plannedAt.localeCompare(b.plannedAt));
}

/** The next weekday it runs when the server hasn't planned one yet (it plans two days ahead). */
function nextDayName(r: CourtRoutine): string | null {
  const { isoWeekday } = wallClockIn(r.tz);
  for (let ahead = 2; ahead <= 8; ahead += 1) {
    const iso = ((isoWeekday - 1 + ahead) % 7) + 1;
    if (maskHas(r.days, iso)) return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][iso - 1];
  }
  return null;
}

/** "Change today's time": the routine's zone, later than now, the same day. */
function moveChoices(o: RoutineOccurrence, tz: string): { id: string; name: string }[] {
  const date = localDateIn(tz, new Date(o.plannedAt));
  const nowMin = date === localDateIn(tz) ? wallClockIn(tz).minutes : -1;
  const from = Math.max(5 * 60, Math.ceil((nowMin + 1) / 15) * 15);
  return clockTimes(15, from, 23 * 60 + 45).map((id) => ({ id, name: formatClockTime(id) }));
}

export default function CourtRoutinesScreen({ route, navigation }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();

  const routinesQ = useCachedQuery(MY_COURT_ROUTINES_KEY, fetchMyCourtRoutines, {
    ttlMs: MY_COURT_ROUTINES_TTL_MS,
    persistMs: MY_COURT_ROUTINES_PERSIST_MS,
  });
  const settingsQ = useCachedQuery(COURT_ROUTINE_SETTINGS_KEY, getCourtRoutineSettings, { ttlMs: 60 * 60_000 });
  const starred = useCourtFavorites().data ?? [];
  const routines = routinesQ.data ?? [];

  const [friends, setFriends] = React.useState<FriendRow[]>([]);
  const [suggestions, setSuggestions] = React.useState<RoutineSuggestion[]>([]);
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set());
  const [editing, setEditing] = React.useState<RoutineDraft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [prefBusy, setPrefBusy] = React.useState(false);
  const [shareBusy, setShareBusy] = React.useState(false);
  const [moving, setMoving] = React.useState<{ o: RoutineOccurrence; r: CourtRoutine } | null>(null);

  const refreshRoutines = routinesQ.refresh;
  useFocusEffect(
    React.useCallback(() => {
      let on = true;
      void refreshRoutines().catch(() => {});
      listMyFriends()
        .then((f) => on && setFriends(f))
        .catch(() => {});
      loadRoutineSuggestions()
        .then((s) => on && setSuggestions(s))
        .catch(() => {});
      AsyncStorage.getItem(ROUTINE_DISMISSED_KEY)
        .then((raw) => on && setDismissed(new Set(raw ? (JSON.parse(raw) as string[]) : [])))
        .catch(() => {});
      return () => {
        on = false;
      };
    }, [refreshRoutines]),
  );

  // Opened from a court ("Make it a routine"): the add sheet, that court picked.
  const newVenue = route.params?.newVenue;
  React.useEffect(() => {
    if (!newVenue) return;
    navigation.setParams({ newVenue: undefined });
    setEditing({ ...newDraft(), venueId: newVenue.venueId, venueName: newVenue.venueName });
  }, [newVenue, navigation]);

  function newDraft(): RoutineDraft {
    const only = starred.length === 1 ? starred[0] : null;
    return {
      id: null,
      venueId: only?.venue_id ?? '',
      venueName: only?.venue_name ?? '',
      localTime: DEFAULT_ROUTINE_TIME,
      days: WEEKDAYS_MASK,
      lengthMin: DEFAULT_PLAY_LENGTH_MIN,
      windows: [],
    };
  }

  async function onSave(draft: RoutineDraft) {
    setSaving(true);
    try {
      // Fitted to the length, same modes joined; nothing said is the same as none.
      await saveCourtRoutine({ ...draft, windows: routineWindowsToSave(draft.windows, draft.lengthMin) });
      setEditing(null);
      toast.success(draft.id ? 'Routine updated' : 'Routine added');
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't save that routine. Try again.", { venueName: draft.venueName }));
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!editing?.id) return;
    setDeleting(true);
    try {
      await deleteCourtRoutine(editing.id);
      setEditing(null);
      toast.success('Routine deleted');
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't delete that routine. Try again."));
    } finally {
      setDeleting(false);
    }
  }

  async function run(id: string, fn: () => Promise<unknown>, done: string, fail: string) {
    setBusyId(id);
    try {
      await fn();
      toast.success(done);
    } catch (e) {
      toast.error(explainRefusal(e, fail));
    } finally {
      setBusyId(null);
    }
  }

  async function addSuggestion(s: RoutineSuggestion) {
    const key = routineSuggestionKey(s);
    await run(
      key,
      () =>
        saveCourtRoutine({ venueId: s.venueId, localTime: s.localTime, days: s.days, lengthMin: s.lengthMin, windows: [] }),
      'Added to your routine',
      "Couldn't add that routine. Try again.",
    );
    setSuggestions((list) => list.filter((x) => routineSuggestionKey(x) !== key));
  }

  function dismissSuggestion(s: RoutineSuggestion) {
    const next = new Set(dismissed).add(routineSuggestionKey(s));
    setDismissed(next);
    AsyncStorage.setItem(ROUTINE_DISMISSED_KEY, JSON.stringify([...next])).catch(() => {});
  }

  async function setAutoCheckin(on: boolean) {
    setPrefBusy(true);
    try {
      await setRoutineAutoCheckin(on);
      void settingsQ.refresh().catch(() => {});
      toast.success(on ? 'Auto check-in on' : 'Auto check-in off');
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't update that setting. Try again."));
    } finally {
      setPrefBusy(false);
    }
  }

  /** "Share my routine stops automatically" (plan sharing). */
  async function setAutoShare(on: boolean) {
    setShareBusy(true);
    try {
      await setAutoShareRoutines(on);
      toast.success(autoShareToggledMessage(on));
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't update that setting. Try again."));
    } finally {
      setShareBusy(false);
    }
  }

  async function moveTo(hhmm: string) {
    const m = moving;
    setMoving(null);
    if (!m) return;
    const date = localDateIn(m.r.tz, new Date(m.o.plannedAt));
    const at = zonedClockToDate(date, hhmm, m.r.tz);
    if (!at) return;
    await run(m.o.planId, () => moveRoutineOccurrence(m.o.planId, at), `Moved to ${formatClockTime(hhmm)}`, "Couldn't change the time. Try again.");
  }

  const shownSuggestions = suggestions.filter((s) => !dismissed.has(routineSuggestionKey(s)));
  const autoOn = settingsQ.data?.routine_auto_checkin !== false;

  if (routinesQ.loading && !routinesQ.data) return <LoadingState />;

  return (
    <View style={S.fill}>
      <ScrollView contentContainerStyle={S.content}>
        {shownSuggestions.length > 0 ? (
          <View style={S.block}>
            <SectionHeader title="Suggested" style={S.label} />
            {shownSuggestions.map((s) => {
              const key = routineSuggestionKey(s);
              return (
                <Panel key={key} padded={false} style={[S.card, { borderColor: c.primary }]}>
                  <Text style={[S.time, { color: c.text }]}>{formatClockTime(s.localTime)}</Text>
                  <Text style={t.title} numberOfLines={1}>{s.venueName}</Text>
                  <Text style={[t.meta, S.cardMeta]} numberOfLines={1}>
                    {formatWeekdayMask(s.days)} · {s.visits} visits in 6 weeks
                  </Text>
                  <View style={S.cardActions}>
                    <Button
                      title="Add"
                      iconName="plus"
                      size="sm"
                      loading={busyId === key}
                      disabled={busyId != null}
                      onPress={() => void addSuggestion(s)}
                      accessibilityLabel={`Add ${s.venueName} to my routine`}
                    />
                    <TouchableOpacity onPress={() => dismissSuggestion(s)} style={S.textBtn} accessibilityRole="button">
                      <Text style={[t.sub, { color: c.textSub }]}>Not now</Text>
                    </TouchableOpacity>
                  </View>
                </Panel>
              );
            })}
          </View>
        ) : null}

        <View style={S.block}>
          <SectionHeader title="My routine" count={routines.length || undefined} style={S.label} />
          {routines.length === 0 ? (
            <Panel padded={false} style={S.card}>
              <Text style={[t.bodySub, { color: c.textMuted }]}>No routines yet.</Text>
            </Panel>
          ) : (
            routines.map((r) => {
              const windowsLine = routineWindowsLine(r);
              const dormant = !r.starred;
              return (
                <Panel key={r.id} padded={false} style={[S.card, (!r.active || dormant) && S.paused]}>
                  <View style={S.cardTop}>
                    <View style={S.cardBody}>
                      <Text style={[S.time, { color: c.text }]} numberOfLines={1}>
                        {formatClockTime(r.localTime)}
                        {zoneSuffix(r.tz)}
                      </Text>
                      <Text style={t.title} numberOfLines={1}>{r.venueName}</Text>
                      <Text style={[t.meta, S.cardMeta]} numberOfLines={1}>
                        {routineTimeLine(r)}
                      </Text>
                      {windowsLine ? (
                        <Text style={[t.meta, S.cardMeta]} numberOfLines={1}>
                          {windowsLine}
                        </Text>
                      ) : null}
                    </View>
                    <TouchableOpacity
                      onPress={() =>
                        setEditing({
                          id: r.id,
                          venueId: r.venueId,
                          venueName: r.venueName,
                          localTime: r.localTime,
                          days: r.days,
                          lengthMin: r.lengthMin,
                          windows: r.windows,
                          tz: r.tz,
                        })
                      }
                      style={S.edit}
                      accessibilityRole="button"
                      accessibilityLabel={`Edit ${r.venueName}`}
                    >
                      <Text style={[t.sub, { color: c.primary }]}>Edit</Text>
                    </TouchableOpacity>
                  </View>

                  {dormant ? (
                    <Text style={[t.sub, S.status, { color: c.textSub }]} numberOfLines={1}>
                      Off: star this court to turn it back on
                    </Text>
                  ) : r.active && occurrencesOf(r).length > 0 ? (
                    occurrencesOf(r).map((o) => {
                      const day = dayLabel(o.plannedAt);
                      const ahead = new Date(o.plannedAt).getTime() > Date.now();
                      const busy = busyId === o.planId;
                      return (
                        <View key={o.planId} style={S.statusRow}>
                          <View style={[S.statusText, S.inline]}>
                            <Text style={[t.sub, S.shrink, { color: c.textSub }]} numberOfLines={1}>
                              {o.status === 'completed'
                                ? `${day} · checked in`
                                : o.status === 'cancelled'
                                  ? `${day} · skipped`
                                  : `${day} ${timeLabel(o.plannedAt, r.localTime)}`}
                            </Text>
                            {o.status === 'completed' ? <Icon name="check-mark" size={14} color={c.success} /> : null}
                          </View>
                          {o.status === 'planned' ? (
                            <>
                              <TouchableOpacity
                                disabled={busyId != null}
                                onPress={() => setMoving({ o, r })}
                                style={[S.pill, { borderColor: c.border }]}
                                accessibilityRole="button"
                                accessibilityLabel={`Change ${day.toLowerCase()}'s time`}
                              >
                                <Text style={[t.sub, { color: c.textSub }]}>Move</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                disabled={busyId != null}
                                onPress={() =>
                                  void run(o.planId, () => skipRoutineOccurrence(o.planId), `Skipped ${day.toLowerCase()}`, "Couldn't skip. Try again.")
                                }
                                style={[S.pill, { borderColor: c.border }]}
                                accessibilityRole="button"
                                accessibilityLabel={`Skip ${day}`}
                              >
                                <Text style={[t.sub, { color: c.textSub }]}>{busy ? 'Skipping…' : 'Skip'}</Text>
                              </TouchableOpacity>
                            </>
                          ) : null}
                          {o.status === 'cancelled' && ahead ? (
                            <TouchableOpacity
                              disabled={busyId != null}
                              onPress={() => void run(o.planId, () => unskipRoutineOccurrence(o.planId), 'Back on', "Couldn't undo. Try again.")}
                              style={[S.pill, { borderColor: c.primary }]}
                              accessibilityRole="button"
                              accessibilityLabel={`Undo skipping ${day}`}
                            >
                              <Text style={[t.sub, { color: c.primary }]}>{busy ? 'Undoing…' : 'Undo'}</Text>
                            </TouchableOpacity>
                          ) : null}
                        </View>
                      );
                    })
                  ) : (
                    <Text style={[t.sub, S.status, { color: c.textSub }]} numberOfLines={1}>
                      {!r.active ? 'Paused' : nextDayName(r) ? `Next: ${nextDayName(r)}` : ''}
                    </Text>
                  )}
                  {!dormant ? (
                    <View style={S.statusRow}>
                      <TouchableOpacity
                        disabled={busyId != null}
                        onPress={() =>
                          void run(r.id, () => setCourtRoutineActive(r.id, !r.active), r.active ? 'Paused' : 'Resumed', "Couldn't update. Try again.")
                        }
                        style={[S.pill, { borderColor: c.border }]}
                        accessibilityRole="button"
                        accessibilityLabel={r.active ? `Pause ${r.venueName}` : `Resume ${r.venueName}`}
                      >
                        <Text style={[t.sub, { color: c.textSub }]}>{r.active ? 'Pause' : 'Resume'}</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </Panel>
              );
            })
          )}
          <Button title="Add a routine" iconName="plus" variant="outline" onPress={() => setEditing(newDraft())} style={S.add} />
        </View>

        {settingsQ.data ? (
          <View style={S.block}>
            <SectionHeader title="Settings" style={S.label} />
            <Panel padded={false} style={S.shareCard}>
              <SettingSwitchRow
                label="Auto check-in at routine courts"
                hint="Within 30 min of the time. Needs Location: Always."
                value={autoOn}
                onChange={(on) => void setAutoCheckin(on)}
                disabled={prefBusy}
              />
              {sharing ? (
                <AutoShareSettingRow
                  value={autoShareOf(settingsQ.data) === true}
                  onChange={(on) => void setAutoShare(on)}
                  disabled={shareBusy}
                  copy={PL_AUTO_SHARE_COPY}
                />
              ) : null}
            </Panel>
          </View>
        ) : null}
      </ScrollView>

      <RoutineEditSheet
        visible={editing != null}
        initial={editing}
        starred={starred}
        friends={friends}
        saving={saving}
        deleting={deleting}
        onSave={(d) => void onSave(d)}
        onDelete={editing?.id ? () => void onDelete() : undefined}
        onClose={() => setEditing(null)}
      />
      <SingleSelectModal
        visible={moving != null}
        title="Change today's time"
        items={moving ? moveChoices(moving.o, moving.r.tz) : []}
        selectedId={moving ? timeLabelClock(moving.o.plannedAt, moving.r.tz) : null}
        onPick={(id) => {
          if (id) void moveTo(id);
          else setMoving(null);
        }}
        onClose={() => setMoving(null)}
        searchPlaceholder="e.g. 9:30"
      />
    </View>
  );
}

/** "HH:MM" of an instant in the routine's zone. */
function timeLabelClock(iso: string, tz: string): string {
  return minutesToClock(wallClockIn(tz, new Date(iso)).minutes);
}

const S = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: SPACE.lg, paddingBottom: SPACE.xl + SPACE.sm, width: '100%', maxWidth: 720, alignSelf: 'center' },
  block: { marginTop: SPACE.md },
  label: { marginBottom: SPACE.sm },
  card: { borderWidth: HAIRLINE, borderRadius: RADIUS.lg, padding: SPACE.md, marginBottom: SPACE.sm },
  // SettingSwitchRow brings its own padding.
  shareCard: { borderWidth: HAIRLINE, borderRadius: RADIUS.lg, marginBottom: SPACE.sm, overflow: 'hidden' },
  paused: { opacity: 0.6 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  cardBody: { flex: 1, minWidth: 0 },
  cardMeta: { marginTop: SPACE.xxs },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, marginTop: SPACE.sm },
  textBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACE.xs },
  edit: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  status: { marginTop: SPACE.sm },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginTop: SPACE.sm, flexWrap: 'wrap' },
  statusText: { flex: 1, minWidth: 120 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  shrink: { flexShrink: 1 },
  pill: { borderWidth: 1.5, borderRadius: RADIUS.pill, minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACE.md },
  add: { marginTop: SPACE.xs, minHeight: 48 },
  // The routine's time: the one thing to read at a glance.
  time: { fontSize: 22, lineHeight: 28, fontWeight: '800' },
});
