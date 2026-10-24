// "Start a new season" (Manage > Start a season, and the strip's "No active
// season · Start in Manage" line). Moved out of LeagueDetailScreen with the
// same insert, the same defaults (name "Season N+1", 12 weeks, lock every 2
// weeks, baseline guessed from the league name) and the same validation copy.
// Restyled onto the foundation TextField / Button / Chip and the token scales.
//
// One copy fix: the lock-in preview used to promise specific per-rank bonuses
// and a fixed 3.250 reset, neither of which matched the server (the reset
// target is the baseline entered here). It now says what the field hint says.
import React, { useEffect, useState } from 'react';
import { ScrollView, View, Text, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { Button, TextField } from '@just-messin-around/expo-foundation/forms';
import { Chip, StatusBanner } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { useStatusMessage } from '../../lib/useStatusMessage';
import { addDaysIso, localIsoDate } from '../../lib/seasonSummary';
import { supabase } from '../../lib/supabase';
import { useTheme } from '../../lib/ThemeContext';
import AppDateTimePicker from '../AppDateTimePicker';

const WEEK_PRESETS = [3, 6, 12] as const;
const LOCK_PRESETS = [1, 2, 4] as const;

/** Pull a PLUPR-style number out of the league name as the default baseline.
 *  Matches "4.5" / "3.0" first, then a bare 2-6 integer; falls back to 3.5. */
export function defaultBaselineFromLeague(name: string | undefined | null): string {
  if (!name) return '3.5';
  const decimal = name.match(/[2-6]\.[0-9]/);
  if (decimal) {
    const v = parseFloat(decimal[0]);
    if (v >= 2 && v <= 6.5) return v.toFixed(1);
  }
  const whole = name.match(/\b([2-6])\b/);
  if (whole) return `${whole[1]}.0`;
  return '3.5';
}

export type SeasonSetupSheetProps = {
  visible: boolean;
  leagueId: string;
  leagueName: string | undefined;
  onClose: () => void;
  /** After the season row was inserted (reload the screen). */
  onCreated: () => void;
};

export default function SeasonSetupSheet({ visible, leagueId, leagueName, onClose, onCreated }: SeasonSetupSheetProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const status = useStatusMessage();
  const [seasonName, setSeasonName] = useState('');
  const [start, setStart] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [totalWeeks, setTotalWeeks] = useState(12);
  const [customWeeks, setCustomWeeks] = useState('');
  const [lockWeeks, setLockWeeks] = useState(2);
  const [customLock, setCustomLock] = useState('');
  const [baseline, setBaseline] = useState('3.5');
  const [creating, setCreating] = useState(false);

  // Reset to the defaults each time the sheet opens (the old openSeasonModal()).
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    // Auto-suggest a season name from how many this league has had.
    supabase.from('league_seasons').select('id', { count: 'exact', head: true }).eq('league_id', leagueId)
      .then(({ count }) => { if (alive) setSeasonName(`Season ${(count ?? 0) + 1}`); });
    setStart(new Date());
    setTotalWeeks(12);
    setLockWeeks(2);
    setCustomWeeks('');
    setCustomLock('');
    setBaseline(defaultBaselineFromLeague(leagueName));
    status.clear();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const effectiveWeeks = totalWeeks === 0 ? parseInt(customWeeks || '0', 10) : totalWeeks;
  const effectiveLock = lockWeeks === 0 ? parseInt(customLock || '0', 10) : lockWeeks;

  function lockDates(): Date[] {
    if (!effectiveWeeks || !effectiveLock) return [];
    const dates: Date[] = [];
    const periods = Math.floor(effectiveWeeks / effectiveLock);
    for (let i = 1; i <= periods; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i * effectiveLock * 7);
      dates.push(d);
    }
    return dates;
  }

  async function create() {
    status.clear();
    if (!seasonName.trim()) { status.error('Please enter a season name.'); return; }
    if (!effectiveWeeks || effectiveWeeks < 1) { status.error('Please set a valid duration.'); return; }
    if (!effectiveLock || effectiveLock < 1) { status.error('Please set a valid lock frequency.'); return; }
    if (effectiveLock > effectiveWeeks) { status.error('Lock frequency cannot exceed season length.'); return; }
    const baselineN = parseFloat(baseline);
    if (!Number.isFinite(baselineN) || baselineN < 2 || baselineN > 6.5) {
      status.error('Baseline PLUPR must be between 2.0 and 6.5.');
      return;
    }

    const uid = await currentUserId(supabase);
    if (!uid) { status.error('Please sign in again.'); return; }

    setCreating(true);
    // The LOCAL day the admin picked (start_date is a date). toISOString()
    // gave the UTC day: a season set up on an evening west of UTC started
    // the next day.
    const startStr = localIsoDate(start);
    const endStr = addDaysIso(startStr, effectiveWeeks * 7);

    const { error } = await supabase.from('league_seasons').insert({
      league_id:            leagueId,
      name:                 seasonName.trim(),
      start_date:           startStr,
      end_date:             endStr,
      total_weeks:          effectiveWeeks,
      lock_frequency_weeks: effectiveLock,
      baseline_plupr:       baselineN,
      status:               localIsoDate(new Date()) >= startStr ? 'active' : 'upcoming',
      created_by:           uid,
    });
    setCreating(false);
    if (error) { status.error(error.message); return; }
    onClose();
    onCreated();
  }

  const preset = (key: string, label: string, active: boolean, onPress: () => void) => (
    <Chip
      key={key}
      label={label}
      tone={active ? 'brand' : 'neutral'}
      selected={active}
      hitBox
      onPress={onPress}
      accessibilityRole="button"
    />
  );

  const dates = visible ? lockDates() : [];
  const baselineShown = Number.isFinite(parseFloat(baseline)) ? parseFloat(baseline).toFixed(2) : 'the baseline';

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView contentContainerStyle={[styles.sheet, { backgroundColor: c.surface }]} keyboardShouldPersistTaps="handled">
        <View style={[styles.iconRow, styles.title]}>
          <Icon name="trophy" size={22} color={c.rarityLegendary} />
          <Text style={[t.h2, styles.flex]} accessibilityRole="header">Start a New Season</Text>
        </View>
        <StatusBanner status={status.value} />

        <TextField label="Season Name" value={seasonName} onChangeText={setSeasonName} placeholder="e.g. Season 1, Spring 2025" />

        <Text style={[t.fieldLabel, styles.label]}>Start Date</Text>
        <TouchableOpacity
          style={[styles.dateBtn, { borderColor: c.border }]}
          onPress={() => setShowDatePicker(true)}
          accessibilityRole="button"
        >
          <View style={styles.iconRow}>
            <Icon name="calendar" size={16} color={c.textSub} />
            <Text style={[t.body, styles.flex, { color: c.text }]}>
              {start.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
            </Text>
          </View>
        </TouchableOpacity>

        <Text style={[t.fieldLabel, styles.label]}>Season Length</Text>
        <View style={styles.presetRow}>
          {WEEK_PRESETS.map((w) => preset(`w${w}`, `${w} weeks`, totalWeeks === w, () => { setTotalWeeks(w); setCustomWeeks(''); }))}
          {preset('wc', 'Custom', totalWeeks === 0, () => setTotalWeeks(0))}
        </View>
        {totalWeeks === 0 ? (
          <TextField value={customWeeks} onChangeText={setCustomWeeks} keyboardType="number-pad" placeholder="Enter number of weeks" />
        ) : null}

        <Text style={[t.fieldLabel, styles.label]}>Lock-In Frequency</Text>
        <Text style={t.hint}>How often standings are frozen as a snapshot</Text>
        <View style={styles.presetRow}>
          {LOCK_PRESETS.map((w) => preset(`l${w}`, `Every ${w}w`, lockWeeks === w, () => { setLockWeeks(w); setCustomLock(''); }))}
          {preset('lc', 'Custom', lockWeeks === 0, () => setLockWeeks(0))}
        </View>
        {lockWeeks === 0 ? (
          <TextField value={customLock} onChangeText={setCustomLock} keyboardType="number-pad" placeholder="Enter lock frequency in weeks" />
        ) : null}

        <Text style={[t.fieldLabel, styles.label]}>Baseline PLUPR</Text>
        <Text style={t.hint}>
          Soft-reset target at end of each period. Top-5 finishers keep small bonuses on top
          of this baseline; everyone else snaps clean to it.
        </Text>
        <TextField value={baseline} onChangeText={setBaseline} keyboardType="decimal-pad" placeholder="e.g. 4.5" />

        {dates.length > 0 ? (
          <View style={[styles.preview, { backgroundColor: c.primaryLight, borderColor: c.primary }]}>
            <Text style={[t.sub, { color: c.primary, fontWeight: FONT.weight.bold }]}>
              {dates.length} lock-in period{dates.length !== 1 ? 's' : ''} · final standings = median rank
            </Text>
            {dates.map((d, i) => (
              <Text key={i} style={[t.sub, { color: c.text }]}>
                Period {i + 1}: {d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                {i === dates.length - 1 ? ' · season ends' : ''}
              </Text>
            ))}
            <Text style={t.meta}>
              PLUPR soft-reset after each period: the top 5 keep a small rank bonus, everyone else resets to {baselineShown}.
            </Text>
          </View>
        ) : null}

        <Button title={creating ? 'Creating…' : 'Create Season'} onPress={create} loading={creating} style={styles.save} />
        <TouchableOpacity style={styles.cancel} onPress={onClose} accessibilityRole="button">
          <Text style={[t.sub, { color: c.textMuted }]}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Inside the sheet's Modal so it stacks above it, not under it. */}
      <AppDateTimePicker
        visible={showDatePicker}
        value={start}
        minimumDate={new Date()}
        onChange={(d: Date) => setStart(d)}
        onClose={() => setShowDatePicker(false)}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Plan section 6: the lg gutter on the sides, xl only at the top and bottom.
  sheet: { paddingHorizontal: SPACE.lg, paddingVertical: SPACE.xl, flexGrow: 1, gap: SPACE.sm },
  title: { marginBottom: SPACE.xs },
  iconRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  flex: { flex: 1, minWidth: 0 },
  label: { marginTop: SPACE.md },
  dateBtn: { minHeight: 44, borderWidth: HAIRLINE, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, justifyContent: 'center' },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.sm },
  preview: { borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.lg, borderWidth: HAIRLINE, gap: SPACE.xs },
  save: { marginTop: SPACE.xl },
  cancel: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
