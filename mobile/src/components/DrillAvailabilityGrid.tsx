import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, PanResponder, StyleSheet,
  LayoutChangeEvent,
} from 'react-native';
import {
  DrillAvailability, DRILL_SLOTS_PER_DAY, dateLabel, dateSubLabel,
  rollingDates, slotLabel, slotsFor, setSlot, totalSlots, emptyDay, isoDate,
} from '../lib/drillTime';
import { useTheme } from '../lib/ThemeContext';

const CELL_H  = 14;
const TIME_W  = 38;

// Quick-fill presets
type Preset = { id: string; icon: string; label: string; build: () => DrillAvailability };

function buildPreset(slotsFor7: number[], dates: string[]): DrillAvailability {
  const out: DrillAvailability = {};
  for (const d of dates) {
    const day = emptyDay();
    for (const s of slotsFor7) day[s] = true;
    out[d] = day;
  }
  return out;
}

const GridCell = React.memo(
  function GridCell({ bg }: { bg: string }) {
    return <View style={[st.cell, { backgroundColor: bg }]} />;
  },
  (prev, next) => prev.bg === next.bg,
);

type Props = {
  availability: DrillAvailability;
  onChange: (av: DrillAvailability) => void;
  onScrollLock: (locked: boolean) => void;
  // Confirmed drill sessions (yellow). Painted yellow over the full
  // length_minutes / 30 cells starting at `slot`.
  confirmedSlots?: { date: string; slot: number; length_minutes?: number }[];
  // Scheduled match commitments (red). Wins over both availability and
  // drill-confirmed paint, since competitive matches outrank drills.
  scheduledMatchSlots?: { date: string; slot: number; length_minutes?: number }[];
};

export default function DrillAvailabilityGrid({ availability, onChange, onScrollLock, confirmedSlots, scheduledMatchSlots }: Props) {
  const { colors, isDark } = useTheme();
  const SEL_BG       = colors.primary;
  const CONFIRMED_BG = isDark ? '#caa028' : '#f5c542';
  const MATCH_BG     = isDark ? '#a13434' : '#e75555';
  const EVEN_BG = isDark ? '#1a2818' : '#ebebeb';
  const ODD_BG  = isDark ? '#243024' : '#f4f4f4';

  // Fast lookup sets keyed by "YYYY-MM-DD:slot", each expanded over their length.
  function expandToSet(slots: { date: string; slot: number; length_minutes?: number }[] | undefined): Set<string> {
    const s = new Set<string>();
    for (const c of slots ?? []) {
      const span = Math.max(1, Math.ceil((c.length_minutes ?? 60) / 30));
      for (let i = 0; i < span; i++) {
        const sl = c.slot + i;
        if (sl >= DRILL_SLOTS_PER_DAY) break; // don't bleed past midnight
        s.add(`${c.date}:${sl}`);
      }
    }
    return s;
  }
  const confirmedSet = useMemo(() => expandToSet(confirmedSlots), [confirmedSlots]);
  const matchSet     = useMemo(() => expandToSet(scheduledMatchSlots), [scheduledMatchSlots]);

  const dates = useMemo(() => rollingDates(), []);
  const numDays = dates.length;

  const [av, setAvState] = useState<DrillAvailability>(() => availability ?? {});
  const avRef = useRef(av);

  const editingRef = useRef(false);
  useEffect(() => {
    if (!editingRef.current) {
      avRef.current = availability ?? {};
      setAvState(availability ?? {});
    }
  }, [availability]);

  const onChangeRef     = useRef(onChange);
  const onScrollLockRef = useRef(onScrollLock);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onScrollLockRef.current = onScrollLock; }, [onScrollLock]);

  const dragMode = useRef(true);
  const cellWRef = useRef(0);
  const gridRef  = useRef<View>(null);
  const gridPage = useRef({ x: 0, y: 0 });
  const rafRef   = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);

  const [editing, setEditing] = useState(false);

  function getCoords(pageX: number, pageY: number): { dateIdx: number; slot: number } | null {
    const cw = cellWRef.current;
    if (cw === 0) return null;
    const relX = pageX - gridPage.current.x - TIME_W;
    const relY = pageY - gridPage.current.y;
    if (relX < 0 || relY < 0) return null;
    const dateIdx = Math.floor(relX / cw);
    const slot    = Math.floor(relY / CELL_H);
    if (dateIdx < 0 || dateIdx >= numDays || slot < 0 || slot >= DRILL_SLOTS_PER_DAY) return null;
    return { dateIdx, slot };
  }

  function applyCell(dateIdx: number, slot: number, val: boolean) {
    const date = dates[dateIdx];
    const current = slotsFor(avRef.current, date)[slot];
    if (current === val) return;
    avRef.current = setSlot(avRef.current, date, slot, val);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setAvState({ ...avRef.current });
      rafRef.current = null;
    });
  }

  function finalizeDrag() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const final = { ...avRef.current };
    setAvState(final);
    onChangeRef.current(final);
  }

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => editingRef.current,
      onMoveShouldSetPanResponder:  () => editingRef.current,
      onPanResponderGrant: (evt) => {
        gridRef.current?.measure((_x, _y, _w, _h, px, py) => {
          gridPage.current = { x: px, y: py };
        });
        const c = getCoords(evt.nativeEvent.pageX, evt.nativeEvent.pageY);
        if (!c) return;
        const cur = slotsFor(avRef.current, dates[c.dateIdx])[c.slot];
        dragMode.current = !cur;
        applyCell(c.dateIdx, c.slot, dragMode.current);
      },
      onPanResponderMove: (evt) => {
        const c = getCoords(evt.nativeEvent.pageX, evt.nativeEvent.pageY);
        if (c) applyCell(c.dateIdx, c.slot, dragMode.current);
      },
      onPanResponderRelease:   finalizeDrag,
      onPanResponderTerminate: finalizeDrag,
    }),
  ).current;

  function toggleEditing() {
    const next = !editingRef.current;
    editingRef.current = next;
    setEditing(next);
    onScrollLockRef.current(next);
  }

  function clearAll() {
    avRef.current = {};
    setAvState({});
    onChangeRef.current({});
  }

  function applyPreset(preset: Preset) {
    const next = preset.build();
    avRef.current = next;
    setAvState(next);
    onChangeRef.current(next);
    if (editingRef.current) {
      editingRef.current = false;
      setEditing(false);
      onScrollLockRef.current(false);
    }
  }

  const PRESETS: Preset[] = useMemo(() => [
    { id: 'evenings',   icon: '🌆', label: 'Evenings (5–9pm)', build: () => buildPreset([34,35,36,37,38,39,40,41], dates) },
    { id: 'mornings',   icon: '🌅', label: 'Mornings (7–10am)', build: () => buildPreset([14,15,16,17,18,19], dates) },
    { id: 'lunch',      icon: '🥗', label: 'Lunch (11:30–1:30)', build: () => buildPreset([23,24,25,26], dates) },
    { id: 'weeknights', icon: '💼', label: 'Weeknights only',
      build: () => {
        const out: DrillAvailability = {};
        for (const d of dates) {
          const day = emptyDay();
          const date = new Date(d + 'T12:00:00');
          const dow = date.getDay();
          if (dow >= 1 && dow <= 5) {
            for (let s = 36; s <= 41; s++) day[s] = true;
          }
          out[d] = day;
        }
        return out;
      },
    },
    { id: 'weekends', icon: '🏖', label: 'Weekends',
      build: () => {
        const out: DrillAvailability = {};
        for (const d of dates) {
          const date = new Date(d + 'T12:00:00');
          const dow = date.getDay();
          out[d] = dow === 0 || dow === 6 ? Array(48).fill(true) : emptyDay();
        }
        return out;
      },
    },
    { id: 'all-week', icon: '☀️', label: 'Open all week', build: () => buildPreset(Array.from({length: 48}, (_,i) => i), dates) },
  ], [dates]);

  function onGridLayout(e: LayoutChangeEvent) {
    cellWRef.current = (e.nativeEvent.layout.width - TIME_W) / numDays;
    gridRef.current?.measure((_x, _y, _w, _h, px, py) => {
      gridPage.current = { x: px, y: py };
    });
  }

  const total = totalSlots(av);
  const totalHours = (total * 0.5).toFixed(1).replace(/\.0$/, '');
  const hasAny = total > 0;

  return (
    <View>
      <View style={st.controls}>
        {hasAny
          ? <Text style={[st.hoursLabel, { color: colors.primary }]}>{totalHours}h available · next 7 days</Text>
          : <Text style={[st.noHoursLabel, { color: colors.textMuted }]}>No drill availability set</Text>
        }
        {(confirmedSet.size > 0 || matchSet.size > 0) && (
          <View style={st.legendGroup}>
            {confirmedSet.size > 0 && (
              <View style={st.legendRow}>
                <View style={[st.legendSwatch, { backgroundColor: CONFIRMED_BG }]} />
                <Text style={[st.legendText, { color: colors.textSub }]}>Drill</Text>
              </View>
            )}
            {matchSet.size > 0 && (
              <View style={st.legendRow}>
                <View style={[st.legendSwatch, { backgroundColor: MATCH_BG }]} />
                <Text style={[st.legendText, { color: colors.textSub }]}>Match</Text>
              </View>
            )}
          </View>
        )}
        <View style={st.controlsRight}>
          {hasAny && (
            <TouchableOpacity onPress={clearAll} style={st.clearBtn}>
              <Text style={[st.clearBtnText, { color: colors.danger }]}>Clear</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[st.editBtn, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }, editing && { borderColor: colors.primary, backgroundColor: colors.primaryLight }]}
            onPress={toggleEditing}
          >
            <Text style={[st.editBtnText, { color: colors.textMuted }, editing && { color: colors.primary }]}>
              {editing ? '✓ Done' : '✏ Edit'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={st.presetsWrap}>
        {PRESETS.map(p => (
          <TouchableOpacity
            key={p.id}
            style={[st.presetChip, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => applyPreset(p)}
            activeOpacity={0.7}
          >
            <Text style={st.presetIcon}>{p.icon}</Text>
            <Text style={[st.presetLabel, { color: colors.text }]}>{p.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {editing && (
        <Text style={[st.hint, { color: colors.textMuted }]}>
          Drag to paint · first touch sets add or remove mode
        </Text>
      )}

      <View ref={gridRef} {...panResponder.panHandlers} onLayout={onGridLayout}>
        {/* Date header */}
        <View style={[st.headerRow, { borderBottomColor: colors.border }]}>
          <View style={{ width: TIME_W }} />
          {dates.map(d => {
            const isToday = d === isoDate(new Date());
            return (
              <View key={d} style={st.dayCell}>
                <Text style={[st.dayText, { color: isToday ? colors.primary : colors.textSub, fontWeight: isToday ? '900' : '700' }]}>
                  {dateLabel(d)}
                </Text>
                <Text style={[st.daySub, { color: colors.textMuted }]}>{dateSubLabel(d)}</Text>
              </View>
            );
          })}
        </View>

        {/* 48 time rows */}
        {Array.from({ length: DRILL_SLOTS_PER_DAY }, (_, slot) => {
          const even = slot % 2 === 0;
          const rowBg = even ? EVEN_BG : ODD_BG;
          return (
            <View key={slot} style={[st.row, { backgroundColor: rowBg }]}>
              <View style={st.timeCell}>
                {slot % 4 === 0 && (
                  <Text style={[st.timeText, { color: colors.textMuted }]}>{slotLabel(slot)}</Text>
                )}
              </View>
              {dates.map((date) => {
                const isSelected = slotsFor(av, date)[slot];
                const key = `${date}:${slot}`;
                const isMatch     = matchSet.has(key);
                const isConfirmed = confirmedSet.has(key);
                // Match (red) > drill (yellow) > available (green) > default
                const bg = isMatch
                  ? MATCH_BG
                  : isConfirmed
                    ? CONFIRMED_BG
                    : isSelected ? SEL_BG : (even ? EVEN_BG : ODD_BG);
                return <GridCell key={date} bg={bg} />;
              })}
            </View>
          );
        })}

        <View style={[st.bottomBorder, { backgroundColor: colors.border }]} />
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  controls:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', rowGap: 4 },
  hoursLabel:      { fontSize: 13, fontWeight: '700' },
  noHoursLabel:    { fontSize: 12 },
  legendGroup:     { flexDirection: 'row', alignItems: 'center', gap: 10 },
  legendRow:       { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendSwatch:    { width: 12, height: 12, borderRadius: 2 },
  legendText:      { fontSize: 11, fontWeight: '600' },
  controlsRight:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  clearBtn:        { paddingHorizontal: 10, paddingVertical: 5 },
  clearBtnText:    { fontSize: 12, fontWeight: '600' },
  editBtn:         { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 10, borderWidth: 1.5 },
  editBtnText:     { fontSize: 12, fontWeight: '700' },

  presetsWrap:     { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  presetChip:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20, borderWidth: 1.5, gap: 4 },
  presetIcon:      { fontSize: 14 },
  presetLabel:     { fontSize: 11, fontWeight: '600' },

  hint:            { fontSize: 10, textAlign: 'center', marginBottom: 5 },

  headerRow:       { flexDirection: 'row', paddingBottom: 5, borderBottomWidth: 1, marginBottom: 1 },
  dayCell:         { flex: 1, alignItems: 'center' },
  dayText:         { fontSize: 11 },
  daySub:          { fontSize: 9, marginTop: 1 },

  row:             { flexDirection: 'row', height: CELL_H },
  timeCell:        { width: TIME_W, justifyContent: 'center', alignItems: 'flex-end', paddingRight: 5 },
  timeText:        { fontSize: 8 },
  cell:            { flex: 1, height: CELL_H, borderRightWidth: 0.5, borderRightColor: 'rgba(0,0,0,0.06)' },
  bottomBorder:    { height: 1, marginLeft: TIME_W },
});
