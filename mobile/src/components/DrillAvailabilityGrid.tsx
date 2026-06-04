import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, PanResponder, StyleSheet,
  ScrollView, LayoutChangeEvent,
} from 'react-native';
import { AVAIL_DAYS, SLOTS_PER_DAY, cellIdx, slotLabel } from '../lib/availability';
import { isoWeekday, isoDate, DRILL_WEEKLY_CELLS, totalWeeklySlots } from '../lib/drillTime';
import { useTheme } from '../lib/ThemeContext';

const CELL_H  = 14;
const TIME_W  = 38;

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ALL_SLOTS = range(0, SLOTS_PER_DAY - 1);
const ALL_DAYS  = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS  = [0, 1, 2, 3, 4]; // Mon–Fri (AVAIL_DAYS is Mon..Sun)
const WEEKENDS  = [5, 6];          // Sat, Sun

// Quick-fill presets build a recurring weekly template (boolean[336]).
type Preset = { id: string; icon: string; label: string; build: () => boolean[] };

function buildWeekly(slots: number[], days: number[]): boolean[] {
  const av = Array(DRILL_WEEKLY_CELLS).fill(false) as boolean[];
  for (const d of days) for (const s of slots) av[cellIdx(d, s)] = true;
  return av;
}

const PRESETS: Preset[] = [
  { id: 'evenings',   icon: '🌆', label: 'Evenings (5–9pm)',   build: () => buildWeekly(range(34, 41), ALL_DAYS) },
  { id: 'mornings',   icon: '🌅', label: 'Mornings (7–10am)',  build: () => buildWeekly(range(14, 19), ALL_DAYS) },
  { id: 'lunch',      icon: '🥗', label: 'Lunch (11:30–1:30)', build: () => buildWeekly(range(23, 26), ALL_DAYS) },
  { id: 'weeknights', icon: '💼', label: 'Weeknights only',    build: () => buildWeekly(range(36, 41), WEEKDAYS) },
  { id: 'weekends',   icon: '🏖', label: 'Weekends',           build: () => buildWeekly(ALL_SLOTS, WEEKENDS) },
  { id: 'all-week',   icon: '☀️', label: 'Open all week',      build: () => buildWeekly(ALL_SLOTS, ALL_DAYS) },
];

const GridCell = React.memo(
  function GridCell({ bg }: { bg: string }) {
    return <View style={[st.cell, { backgroundColor: bg }]} />;
  },
  (prev, next) => prev.bg === next.bg,
);

type Overlay = { date: string; slot: number; length_minutes?: number };

type Props = {
  // Recurring weekly template: boolean[336] (7 weekdays × 48 slots, 0=Mon..6=Sun).
  availability: boolean[];
  onChange: (av: boolean[]) => void;
  onScrollLock: (locked: boolean) => void;
  // Confirmed drill sessions (yellow) over the next 7 days. Date-keyed; each is
  // mapped onto its weekday column and painted over its length_minutes / 30 cells.
  confirmedSlots?: Overlay[];
  // Scheduled match commitments (red). Wins over availability + drill-confirmed
  // paint, since competitive matches outrank drills.
  scheduledMatchSlots?: Overlay[];
};

export default function DrillAvailabilityGrid({ availability, onChange, onScrollLock, confirmedSlots, scheduledMatchSlots }: Props) {
  const { colors, isDark } = useTheme();
  const SEL_BG       = colors.primary;
  const CONFIRMED_BG = isDark ? '#caa028' : '#f5c542';
  const MATCH_BG     = isDark ? '#a13434' : '#e75555';
  const EVEN_BG = isDark ? '#1a2818' : '#ebebeb';
  const ODD_BG  = isDark ? '#243024' : '#f4f4f4';

  // Map date-keyed overlays onto flat weekly cell indices (cellIdx(weekday, slot)),
  // expanded across each commitment's length. The next 7 days cover each weekday
  // exactly once, so this paints the grid "as if the next 7 days were shown".
  function expandToCellSet(slots: Overlay[] | undefined): Set<number> {
    const s = new Set<number>();
    for (const c of slots ?? []) {
      const wd   = isoWeekday(c.date);
      const span = Math.max(1, Math.ceil((c.length_minutes ?? 60) / 30));
      for (let i = 0; i < span; i++) {
        const sl = c.slot + i;
        if (sl >= SLOTS_PER_DAY) break; // don't bleed past midnight into the next day's column
        s.add(cellIdx(wd, sl));
      }
    }
    return s;
  }
  const confirmedSet = useMemo(() => expandToCellSet(confirmedSlots), [confirmedSlots]);
  const matchSet     = useMemo(() => expandToCellSet(scheduledMatchSlots), [scheduledMatchSlots]);

  // Highlight the column for today's weekday so the overlays orient to "now".
  const todayWd = useMemo(() => isoWeekday(isoDate(new Date())), []);

  const [av, setAvState] = useState<boolean[]>(() =>
    availability.length === DRILL_WEEKLY_CELLS ? [...availability] : Array(DRILL_WEEKLY_CELLS).fill(false),
  );
  const avRef = useRef(av);

  const editingRef = useRef(false);
  useEffect(() => {
    if (!editingRef.current && availability.length === DRILL_WEEKLY_CELLS) {
      avRef.current = [...availability];
      setAvState([...availability]);
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

  function getIdx(pageX: number, pageY: number): number | null {
    const cw = cellWRef.current;
    if (cw === 0) return null;
    const relX = pageX - gridPage.current.x - TIME_W;
    const relY = pageY - gridPage.current.y;
    if (relX < 0 || relY < 0) return null;
    const d = Math.floor(relX / cw);
    const s = Math.floor(relY / CELL_H);
    if (d < 0 || d >= 7 || s < 0 || s >= SLOTS_PER_DAY) return null;
    return cellIdx(d, s);
  }

  function applyCell(idx: number, val: boolean) {
    if (avRef.current[idx] === val) return;
    avRef.current[idx] = val;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setAvState([...avRef.current]);
      rafRef.current = null;
    });
  }

  function finalizeDrag() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const final = [...avRef.current];
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
        const idx = getIdx(evt.nativeEvent.pageX, evt.nativeEvent.pageY);
        if (idx === null) return;
        dragMode.current = !avRef.current[idx];
        applyCell(idx, dragMode.current);
      },
      onPanResponderMove: (evt) => {
        const idx = getIdx(evt.nativeEvent.pageX, evt.nativeEvent.pageY);
        if (idx !== null) applyCell(idx, dragMode.current);
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
    const blank = Array(DRILL_WEEKLY_CELLS).fill(false) as boolean[];
    avRef.current = blank;
    setAvState(blank);
    onChangeRef.current(blank);
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

  function onGridLayout(e: LayoutChangeEvent) {
    cellWRef.current = (e.nativeEvent.layout.width - TIME_W) / 7;
    gridRef.current?.measure((_x, _y, _w, _h, px, py) => {
      gridPage.current = { x: px, y: py };
    });
  }

  const total = totalWeeklySlots(av);
  const totalHours = (total * 0.5).toFixed(1).replace(/\.0$/, '');
  const hasAny = total > 0;

  return (
    <View>
      <View style={st.controls}>
        {hasAny
          ? <Text style={[st.hoursLabel, { color: colors.primary }]}>{totalHours}h / week available</Text>
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

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={st.presetsScroll}
        contentContainerStyle={st.presetsContent}
      >
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
      </ScrollView>

      {editing && (
        <Text style={[st.hint, { color: colors.textMuted }]}>
          Drag to paint · first touch sets add or remove mode
        </Text>
      )}

      <View ref={gridRef} {...panResponder.panHandlers} onLayout={onGridLayout}>
        {/* Day-name header (recurring weekly; today's weekday is highlighted) */}
        <View style={[st.headerRow, { borderBottomColor: colors.border }]}>
          <View style={{ width: TIME_W }} />
          {AVAIL_DAYS.map((d, i) => {
            const isToday = i === todayWd;
            return (
              <View key={d} style={st.dayCell}>
                <Text style={[st.dayText, { color: isToday ? colors.primary : colors.textSub, fontWeight: isToday ? '900' : '700' }]}>
                  {d}
                </Text>
              </View>
            );
          })}
        </View>

        {/* 48 time rows */}
        {Array.from({ length: SLOTS_PER_DAY }, (_, slot) => {
          const even = slot % 2 === 0;
          const rowBg = even ? EVEN_BG : ODD_BG;
          return (
            <View key={slot} style={[st.row, { backgroundColor: rowBg }]}>
              <View style={st.timeCell}>
                {slot % 4 === 0 && (
                  <Text style={[st.timeText, { color: colors.textMuted }]}>{slotLabel(slot)}</Text>
                )}
              </View>
              {Array.from({ length: 7 }, (_, day) => {
                const idx = cellIdx(day, slot);
                const isMatch     = matchSet.has(idx);
                const isConfirmed = confirmedSet.has(idx);
                // Match (red) > drill (yellow) > available (green) > zebra default
                const bg = isMatch
                  ? MATCH_BG
                  : isConfirmed
                    ? CONFIRMED_BG
                    : av[idx] ? SEL_BG : (even ? EVEN_BG : ODD_BG);
                return <GridCell key={day} bg={bg} />;
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

  presetsScroll:   { marginBottom: 8 },
  presetsContent:  { gap: 8, paddingBottom: 2 },
  presetChip:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, borderWidth: 1.5, gap: 5 },
  presetIcon:      { fontSize: 15 },
  presetLabel:     { fontSize: 12, fontWeight: '600' },

  hint:            { fontSize: 10, textAlign: 'center', marginBottom: 5 },

  headerRow:       { flexDirection: 'row', paddingBottom: 5, borderBottomWidth: 1, marginBottom: 1 },
  dayCell:         { flex: 1, alignItems: 'center' },
  dayText:         { fontSize: 11 },

  row:             { flexDirection: 'row', height: CELL_H },
  timeCell:        { width: TIME_W, justifyContent: 'center', alignItems: 'flex-end', paddingRight: 5 },
  timeText:        { fontSize: 8 },
  cell:            { flex: 1, height: CELL_H, borderRightWidth: 0.5, borderRightColor: 'rgba(0,0,0,0.06)' },
  bottomBorder:    { height: 1, marginLeft: TIME_W },
});
