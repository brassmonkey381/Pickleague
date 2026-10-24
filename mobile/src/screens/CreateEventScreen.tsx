// "New event" (Events > +): title, court, notes, minimum, the vote deadline and
// 2-6 proposed times.
//
// Glyphs + tokens (2026-10-24): the inputs are the foundation TextField, the
// deadline presets are Chips (as SeasonSetupSheet's presets), the result is a
// StatusBanner (words, no check / cross characters), Create is the foundation
// Button, and the arrow between a time option's Start and End is a glyph.
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView,
} from 'react-native';
import { Button, TextField } from '@just-messin-around/expo-foundation/forms';
import { Chip, StatusBanner } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';
import AppDateTimePicker from '../components/AppDateTimePicker';
import CourtPicker, { CourtResult } from '../components/CourtPicker';
import { useTheme } from '../lib/ThemeContext';
import { sbCall, requireUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'CreateEvent'>;
  route: RouteProp<RootStackParamList, 'CreateEvent'>;
};

type SlotDraft = { startsAt: Date; endsAt: Date };

type ActivePicker = {
  value: Date;
  minimumDate?: Date;
  onPick: (date: Date) => void;
};

const DEADLINE_PRESETS = [
  { label: '12 hours', hours: 12 },
  { label: '24 hours', hours: 24 },
  { label: '48 hours', hours: 48 },
];

function addHours(h: number): Date {
  return new Date(Date.now() + h * 3600 * 1000);
}

function defaultSlot(offsetDays: number): SlotDraft {
  const start = new Date();
  start.setDate(start.getDate() + offsetDays);
  start.setHours(18, 0, 0, 0);
  const end = new Date(start);
  end.setHours(20, 0, 0, 0);
  return { startsAt: start, endsAt: end };
}

function fmtDate(d: Date) {
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtTime(d: Date) {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export default function CreateEventScreen({ navigation, route }: Props) {
  const { leagueId } = route.params;
  const { colors } = useTheme();
  const S = makeStyles(colors);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // Via the standard venue picker (our catalog + GPS), same as tournaments —
  // not a freeform text field, so events get coordinates too.
  const [location, setLocation] = useState<CourtResult | null>(null);
  // Blank = no minimum, which is the previous behaviour: whatever time wins,
  // wins. Set it and the event cancels itself if the best time can't reach it.
  const [minPlayers, setMinPlayers] = useState('');
  const [deadlinePreset, setDeadlinePreset] = useState<number>(24);
  const [customDeadline, setCustomDeadline] = useState<Date | null>(null);
  const [slots, setSlots] = useState<SlotDraft[]>([defaultSlot(1), defaultSlot(2)]);

  // Single shared picker state
  const [activePicker, setActivePicker] = useState<ActivePicker | null>(null);

  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; isError: boolean } | null>(null);

  const inFlight = useRef(false);
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // An event whose slots insert failed is live with voting open and ZERO time
  // options, and league_events has no delete policy — it can't be rolled back.
  // Remembering it means a retry finishes THAT event instead of orphaning it
  // and creating another.
  const createdEventId = useRef<string | null>(null);

  useEffect(() => () => { if (navTimer.current) clearTimeout(navTimer.current); }, []);

  const voteEndsAt = customDeadline ?? addHours(deadlinePreset);

  function openPicker(value: Date, minimumDate: Date | undefined, onPick: (d: Date) => void) {
    setActivePicker({ value, minimumDate, onPick });
  }

  function editSlot(slotIndex: number, field: 'start' | 'end') {
    const current = field === 'start' ? slots[slotIndex].startsAt : slots[slotIndex].endsAt;
    openPicker(current, field === 'start' ? new Date() : undefined, (picked) => {
      setSlots((prev) =>
        prev.map((s, i) => {
          if (i !== slotIndex) return s;
          if (field === 'end') return { ...s, endsAt: picked };
          // Moving the start: if it lands at/past the current end, carry the end
          // forward by the original duration so the slot keeps its length
          // (e.g. a 16h slot pushed 7 days out stays 16h long). Otherwise leave
          // the end where the user put it.
          const durationMs = s.endsAt.getTime() - s.startsAt.getTime();
          if (picked.getTime() >= s.endsAt.getTime()) {
            return { ...s, startsAt: picked, endsAt: new Date(picked.getTime() + durationMs) };
          }
          return { ...s, startsAt: picked };
        })
      );
      setActivePicker(null);
    });
  }

  function editDeadline() {
    const current = customDeadline ?? addHours(deadlinePreset);
    setCustomDeadline(current); // highlight button immediately on click
    openPicker(current, new Date(), (picked) => {
      setCustomDeadline(picked);
      setActivePicker(null);
    });
  }

  function addSlot() {
    if (slots.length >= 6) return;
    setSlots([...slots, defaultSlot(slots.length + 1)]);
  }

  function removeSlot(index: number) {
    if (slots.length <= 2) return;
    setSlots(slots.filter((_, i) => i !== index));
  }

  async function submit() {
    if (inFlight.current || created) return;
    setStatusMsg(null);

    if (!title.trim()) {
      setStatusMsg({ text: 'Please enter an event title.', isError: true });
      return;
    }
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].endsAt <= slots[i].startsAt) {
        setStatusMsg({ text: `Option ${i + 1}: end time must be after start time.`, isError: true });
        return;
      }
    }
    if (voteEndsAt <= new Date()) {
      setStatusMsg({ text: 'Vote deadline must be in the future.', isError: true });
      return;
    }
    const minPlayersValue = minPlayers.trim() ? Number(minPlayers.trim()) : null;
    if (minPlayersValue !== null && (!Number.isInteger(minPlayersValue) || minPlayersValue < 1)) {
      setStatusMsg({ text: 'Minimum players must be a whole number of 1 or more.', isError: true });
      return;
    }

    inFlight.current = true;
    setLoading(true);
    try {
      // LOCAL session read — getUser() is a network call that hands back
      // { user: null } offline, and `user!.id` then threw out of this handler
      // with the button frozen on "Creating...".
      const uid = await requireUserId(supabase, 'Please sign in again to create an event.');

      // Not retried: nothing dedupes league_events, and a retry after a lost
      // reply would leave two events voting against each other.
      let eventId = createdEventId.current;
      if (!eventId) {
        const event = await sbCall(() => supabase
          .from('league_events')
          .insert({
            league_id: leagueId,
            title: title.trim(),
            description: description.trim() || null,
            location_name: location?.name ?? null,
            location_lat:  location?.lat ?? null,
            location_lng:  location?.lng ?? null,
            created_by: uid,
            vote_ends_at: voteEndsAt.toISOString(),
            min_players: minPlayersValue,
          })
          .select()
          .single(), { retries: 0, timeoutMs: 30_000 }) as { id: string };
        eventId = event.id;
        createdEventId.current = eventId;
      }

      // The event is already votable at this point, so the slots are the half
      // that must not be lost — and must not be doubled. Check first: on a retry
      // (or a lost reply) the rows may already be there.
      const existing = await sbCall(() => supabase
        .from('event_slots').select('id').eq('event_id', eventId)) as { id: string }[] | null;
      if (!existing || existing.length === 0) {
        await sbCall(() => supabase.from('event_slots').insert(
          slots.map((s) => ({
            event_id: eventId,
            starts_at: s.startsAt.toISOString(),
            ends_at: s.endsAt.toISOString(),
          }))
        ), { retries: 0, timeoutMs: 30_000 });
      }

      setCreated(true);
      setStatusMsg({ text: 'Event created! Voting is now open.', isError: false });
      navTimer.current = setTimeout(() => navigation.goBack(), 1200);
    } catch (e) {
      const base = friendlySbMessage(e, 'Failed to create event. Please try again.');
      setStatusMsg({
        text: createdEventId.current
          // Be explicit: the event exists but has no time options yet, and the
          // only way to give it any is to finish this same submit.
          ? `${base}\n\nThe event was created but has no time options yet — tap Create again to finish it.`
          : base,
        isError: true,
      });
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  return (
    <>
      <ScrollView contentContainerStyle={S.container} keyboardShouldPersistTaps="handled">
        {/* Title */}
        <TextField
          label="Event Title"
          placeholder="e.g. May League Night"
          value={title}
          onChangeText={setTitle}
          containerStyle={S.field}
        />

        <Text style={S.label}>Location (optional)</Text>
        <CourtPicker
          value={location}
          onSelect={setLocation}
          active
          showNoneOption
          placeholder="Search for a court or venue…"
        />

        <TextField
          label="Description (optional)"
          placeholder="Notes, what to bring..."
          value={description}
          onChangeText={setDescription}
          multiline
          style={S.multiline}
          containerStyle={S.field}
        />

        <Text style={S.label}>Minimum players (optional)</Text>
        <Text style={S.hint}>
          If no single time option gets at least this many players, the event is
          cancelled when voting closes. Leave blank for no minimum.
        </Text>
        <TextField
          placeholder="e.g. 4"
          value={minPlayers}
          onChangeText={(v) => setMinPlayers(v.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          maxLength={3}
          containerStyle={S.fieldTight}
        />

        {/* Vote deadline */}
        <Text style={S.sectionHeader}>Vote Deadline</Text>
        <Text style={S.hint}>Players have until this time to mark their availability.</Text>

        <View style={S.presetRow}>
          {DEADLINE_PRESETS.map((p) => {
            const active = deadlinePreset === p.hours && !customDeadline;
            return (
              <Chip
                key={p.hours}
                label={p.label}
                tone={active ? 'brand' : 'neutral'}
                selected={active}
                hitBox
                onPress={() => { setDeadlinePreset(p.hours); setCustomDeadline(null); }}
                accessibilityRole="button"
              />
            );
          })}
          <Chip
            label="Custom"
            tone={customDeadline ? 'brand' : 'neutral'}
            selected={!!customDeadline}
            hitBox
            onPress={editDeadline}
            accessibilityRole="button"
          />
        </View>

        <TouchableOpacity style={S.deadlineDisplay} onPress={editDeadline} accessibilityRole="button">
          <Icon name="clock" size={14} color={colors.textMuted} />
          <Text style={S.deadlineLabel}>Closes</Text>
          <Text style={S.deadlineValue}>
            {voteEndsAt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
            {'  '}
            {voteEndsAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </TouchableOpacity>

        {/* Proposed slots */}
        <Text style={S.sectionHeader}>Proposed Time Options</Text>
        <Text style={S.hint}>Add 2–6 options. Players vote for the ones they can attend.</Text>

        {slots.map((slot, i) => (
          <View key={i} style={S.slotCard}>
            <View style={S.slotHeader}>
              <Text style={S.slotNum}>Option {i + 1}</Text>
              {slots.length > 2 && (
                <TouchableOpacity
                  onPress={() => removeSlot(i)}
                  style={S.removeBox}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove option ${i + 1}`}
                >
                  <Text style={S.removeBtn}>Remove</Text>
                </TouchableOpacity>
              )}
            </View>
            <View style={S.slotRow}>
              <TouchableOpacity style={S.timeBtn} onPress={() => editSlot(i, 'start')} accessibilityRole="button">
                <Text style={S.timeBtnLabel}>Start</Text>
                <Text style={S.timeBtnDate}>{fmtDate(slot.startsAt)}</Text>
                <Text style={S.timeBtnTime}>{fmtTime(slot.startsAt)}</Text>
              </TouchableOpacity>
              <Icon name="arrow-right" size={16} color={colors.textMuted} />
              <TouchableOpacity style={S.timeBtn} onPress={() => editSlot(i, 'end')} accessibilityRole="button">
                <Text style={S.timeBtnLabel}>End</Text>
                <Text style={S.timeBtnDate}>{fmtDate(slot.endsAt)}</Text>
                <Text style={S.timeBtnTime}>{fmtTime(slot.endsAt)}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}

        {slots.length < 6 && (
          <TouchableOpacity style={S.addSlotBtn} onPress={addSlot} accessibilityRole="button">
            <Icon name="plus" size={16} color={colors.primary} />
            <Text style={S.addSlotText}>Add another time option</Text>
          </TouchableOpacity>
        )}

        {/* Status message */}
        <StatusBanner
          status={statusMsg ? { kind: statusMsg.isError ? 'error' : 'success', text: statusMsg.text } : null}
          style={S.status}
        />

        <Button
          title={loading ? 'Creating...' : created ? 'Created' : 'Create Event & Open Voting'}
          onPress={submit}
          loading={loading}
          disabled={loading || created}
          style={S.submit}
        />
      </ScrollView>

      {/* Picker rendered outside ScrollView so it's not clipped */}
      <AppDateTimePicker
        visible={activePicker !== null}
        value={activePicker?.value ?? new Date()}
        minimumDate={activePicker?.minimumDate}
        onChange={(date) => activePicker?.onPick(date)}
        onClose={() => setActivePicker(null)}
      />
    </>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    // The lg gutter on the sides, as every sheet and form.
    container: { padding: SPACE.lg, backgroundColor: c.surface, flexGrow: 1, paddingBottom: SPACE.xl * 2 },
    // Same type and gap as TextField's own label, so the picker's label and
    // the fields' labels read as one set.
    label: { ...t.fieldLabel, marginTop: SPACE.lg, marginBottom: SPACE.xs + SPACE.xxs },
    field: { marginTop: SPACE.lg, marginBottom: 0 },
    fieldTight: { marginBottom: 0 },
    multiline: { minHeight: 72, textAlignVertical: 'top' },
    sectionHeader: { ...t.h3, marginTop: SPACE.xl, marginBottom: SPACE.xs },
    hint: { ...t.hint, marginBottom: SPACE.md },
    presetRow: { flexDirection: 'row', columnGap: SPACE.sm, flexWrap: 'wrap', marginBottom: SPACE.xs },
    deadlineDisplay: {
      flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44,
      backgroundColor: c.bg, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, marginBottom: SPACE.xs,
    },
    deadlineLabel: { ...t.fieldLabel },
    deadlineValue: { ...t.bodySub, color: c.text, fontWeight: FONT.weight.semibold },
    slotCard: {
      backgroundColor: c.surfaceAlt, borderRadius: RADIUS.lg, padding: SPACE.md, marginBottom: SPACE.sm,
      borderWidth: HAIRLINE, borderColor: c.border,
    },
    slotHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACE.sm },
    slotNum: { ...t.title },
    // A 44 box that hugs the word (react-native-web ignores hitSlop); the
    // negative margin keeps the header row as tall as before.
    removeBox: { minHeight: 44, minWidth: 44, alignItems: 'flex-end', justifyContent: 'center', marginVertical: -SPACE.md },
    removeBtn: { ...t.sub, color: c.danger, fontWeight: FONT.weight.semibold },
    slotRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    timeBtn: {
      flex: 1, minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md,
      padding: SPACE.sm, backgroundColor: c.surface, alignItems: 'center',
    },
    timeBtnLabel: { ...t.fieldLabel, marginBottom: SPACE.xxs },
    timeBtnDate: { ...t.sub, color: c.text, fontWeight: FONT.weight.semibold },
    timeBtnTime: { ...t.meta, color: c.primary, marginTop: SPACE.xxs },
    addSlotBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, minHeight: 44,
      borderWidth: 1.5, borderColor: c.primary, borderRadius: RADIUS.md, padding: SPACE.md, marginBottom: SPACE.sm, borderStyle: 'dashed',
    },
    addSlotText: { ...t.title, color: c.primary },
    status: { marginTop: SPACE.md, marginBottom: SPACE.xs },
    submit: { marginTop: SPACE.lg },
  });
}
