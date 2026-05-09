import React, { useRef, useState, useMemo, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, PanResponder, StyleSheet,
  ScrollView, LayoutChangeEvent,
} from 'react-native';
import {
  AVAIL_DAYS, SLOTS_PER_DAY, cellIdx, slotLabel,
  formatAvailabilitySummary,
} from '../lib/availability';
import { useTheme } from '../lib/ThemeContext';

// ── Layout constants ──────────────────────────────────────────
const CELL_H  = 14;
const TIME_W  = 38;

// ── Presets ───────────────────────────────────────────────────
type Preset = { id: string; icon: string; label: string; build: () => boolean[] };

const PRESETS: Preset[] = [
  {
    id: 'weekend_warrior', icon: '🏖', label: 'Weekend Warrior',
    build: () => {
      const av = Array(336).fill(false) as boolean[];
      for (const d of [5, 6])
        for (let s = 0; s < 48; s++) av[cellIdx(d, s)] = true;
      return av;
    },
  },
  {
    id: 'weekday_unwinder', icon: '🌆', label: 'Weekday Unwinder',
    build: () => {
      const av = Array(336).fill(false) as boolean[];
      for (let d = 0; d <= 4; d++)
        for (let s = 36; s <= 43; s++) av[cellIdx(d, s)] = true; // 6 pm – 10 pm
      return av;
    },
  },
  {
    id: 'prime_time', icon: '⭐', label: 'Prime Time',
    build: () => {
      const av = Array(336).fill(false) as boolean[];
      for (const d of [5, 6])
        for (let s = 0; s < 48; s++) av[cellIdx(d, s)] = true; // full weekends
      for (let d = 0; d <= 4; d++)
        for (let s = 34; s <= 41; s++) av[cellIdx(d, s)] = true; // weekday 5–9 pm
      return av;
    },
  },
  {
    id: 'all_day', icon: '☀️', label: "All Day E'ry Day",
    build: () => Array(336).fill(true) as boolean[],
  },
  {
    id: 'early_bird', icon: '🌅', label: 'Early Bird',
    build: () => {
      const av = Array(336).fill(false) as boolean[];
      for (let d = 0; d < 7; d++)
        for (let s = 12; s <= 19; s++) av[cellIdx(d, s)] = true; // 6 am – 10 am
      return av;
    },
  },
  {
    id: 'lunch_league', icon: '🥗', label: 'Lunch League',
    build: () => {
      const av = Array(336).fill(false) as boolean[];
      for (let d = 0; d <= 4; d++)
        for (let s = 23; s <= 27; s++) av[cellIdx(d, s)] = true; // 11:30 am – 2 pm
      return av;
    },
  },
  {
    id: 'night_owl', icon: '🦉', label: 'Night Owl',
    build: () => {
      const av = Array(336).fill(false) as boolean[];
      for (let d = 0; d < 7; d++)
        for (let s = 40; s <= 47; s++) av[cellIdx(d, s)] = true; // 8 pm – midnight
      return av;
    },
  },
  {
    id: 'after_work', icon: '💼', label: 'After Work',
    build: () => {
      const av = Array(336).fill(false) as boolean[];
      for (let d = 0; d <= 4; d++)
        for (let s = 34; s <= 39; s++) av[cellIdx(d, s)] = true; // 5–8 pm weekdays
      return av;
    },
  },
];

// ── Memoized cell — only re-renders when its background changes ────
const GridCell = React.memo(
  function GridCell({ bg }: { bg: string }) {
    return <View style={[st.cell, { backgroundColor: bg }]} />;
  },
  (prev, next) => prev.bg === next.bg,
);

// ── Component ─────────────────────────────────────────────────
type Props = {
  availability: boolean[];
  onChange: (av: boolean[]) => void;
  onScrollLock: (locked: boolean) => void;
};

export default function AvailabilityGrid({ availability, onChange, onScrollLock }: Props) {
  const { colors, isDark } = useTheme();
  const SEL_BG  = colors.primary;
  const EVEN_BG = isDark ? '#1a2818' : '#ebebeb';
  const ODD_BG  = isDark ? '#243024' : '#f4f4f4';
  const [av, setAvState] = useState<boolean[]>(() =>
    availability.length === 336 ? [...availability] : Array(336).fill(false),
  );

  // Ref mirrors state so PanResponder callbacks always see current values
  const avRef = useRef(av);

  // Prop sync: when parent reloads profile, reset local copy (only if not editing)
  const editingRef = useRef(false);
  useEffect(() => {
    if (!editingRef.current && availability.length === 336) {
      avRef.current = [...availability];
      setAvState([...availability]);
    }
  }, [availability]);

  // Stable refs so PanResponder callbacks (created once) always get fresh values
  const onChangeRef      = useRef(onChange);
  const onScrollLockRef  = useRef(onScrollLock);
  useEffect(() => { onChangeRef.current = onChange; },      [onChange]);
  useEffect(() => { onScrollLockRef.current = onScrollLock; }, [onScrollLock]);

  const dragMode   = useRef(true);          // true = painting, false = erasing
  const cellWRef   = useRef(0);
  const gridRef    = useRef<View>(null);
  const gridPage   = useRef({ x: 0, y: 0 });
  const rafRef     = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);

  const [editing, setEditing] = useState(false);

  // ── Cell helpers ──────────────────────────────────────────────
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

  // Mutate ref immediately; batch React state via RAF for smooth visual feedback
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

  // ── PanResponder — created once, uses refs internally ─────────
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => editingRef.current,
      onMoveShouldSetPanResponder:  () => editingRef.current,
      onPanResponderGrant: (evt) => {
        // Re-measure grid position at touch start (accounts for page scroll)
        gridRef.current?.measure((_x, _y, _w, _h, px, py) => {
          gridPage.current = { x: px, y: py };
        });
        const { pageX, pageY } = evt.nativeEvent;
        const idx = getIdx(pageX, pageY);
        if (idx === null) return;
        // First cell's current state determines paint vs erase for this drag
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

  // ── Editing mode ──────────────────────────────────────────────
  function toggleEditing() {
    const next = !editingRef.current;
    editingRef.current = next;
    setEditing(next);
    onScrollLockRef.current(next);
  }

  function clearAll() {
    const blank = Array(336).fill(false) as boolean[];
    avRef.current = blank;
    setAvState(blank);
    onChangeRef.current(blank);
  }

  function applyPreset(preset: Preset) {
    const next = preset.build();
    avRef.current = next;
    setAvState(next);
    onChangeRef.current(next);
    // Exit edit mode if active so the scroll unlocks
    if (editingRef.current) {
      editingRef.current = false;
      setEditing(false);
      onScrollLockRef.current(false);
    }
  }

  // ── Grid layout ───────────────────────────────────────────────
  function onGridLayout(e: LayoutChangeEvent) {
    cellWRef.current = (e.nativeEvent.layout.width - TIME_W) / 7;
    gridRef.current?.measure((_x, _y, _w, _h, px, py) => {
      gridPage.current = { x: px, y: py };
    });
  }

  // ── Derived display values ────────────────────────────────────
  const summary    = useMemo(() => formatAvailabilitySummary(av), [av]);
  const hasAny     = useMemo(() => av.some(Boolean), [av]);
  const totalHours = useMemo(
    () => (av.filter(Boolean).length * 0.5).toFixed(1).replace(/\.0$/, ''),
    [av],
  );

  // ── Render ────────────────────────────────────────────────────
  return (
    <View>
      {/* Controls row */}
      <View style={st.controls}>
        {hasAny
          ? <Text style={[st.hoursLabel, { color: colors.primary }]}>{totalHours} h / week</Text>
          : <Text style={[st.noHoursLabel, { color: colors.textMuted }]}>No availability set</Text>
        }
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

      {/* Preset chips */}
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
          Drag to paint · first touch of each drag sets add or remove mode
        </Text>
      )}

      {/* Interactive grid */}
      <View ref={gridRef} {...panResponder.panHandlers} onLayout={onGridLayout}>
        {/* Day-name header */}
        <View style={[st.headerRow, { borderBottomColor: colors.border }]}>
          <View style={{ width: TIME_W }} />
          {AVAIL_DAYS.map(d => (
            <View key={d} style={st.dayCell}>
              <Text style={[st.dayText, { color: colors.textSub }]}>{d}</Text>
            </View>
          ))}
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
                const isSelected = av[cellIdx(day, slot)];
                const bg = isSelected ? SEL_BG : (even ? EVEN_BG : ODD_BG);
                return <GridCell key={day} bg={bg} />;
              })}
            </View>
          );
        })}

        {/* Closing border */}
        <View style={[st.bottomBorder, { backgroundColor: colors.border }]} />
      </View>

      {/* Availability summary */}
      {hasAny ? (
        <View style={[st.summaryBox, { backgroundColor: colors.primaryLight }]}>
          <Text style={[st.summaryText, { color: colors.primary }]}>{summary}</Text>
        </View>
      ) : !editing ? (
        <Text style={[st.emptyText, { color: colors.textMuted }]}>
          Pick a preset above, or tap ✏ Edit to draw your schedule
        </Text>
      ) : null}
    </View>
  );
}

// ── Styles (color-free; theme overrides applied inline) ──────
const st = StyleSheet.create({
  controls:          { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  hoursLabel:        { fontSize: 13, fontWeight: '700' },
  noHoursLabel:      { fontSize: 12 },
  controlsRight:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  clearBtn:          { paddingHorizontal: 10, paddingVertical: 5 },
  clearBtnText:      { fontSize: 12, fontWeight: '600' },
  editBtn:           { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 10, borderWidth: 1.5 },
  editBtnText:       { fontSize: 12, fontWeight: '700' },

  presetsScroll:     { marginBottom: 8 },
  presetsContent:    { gap: 8, paddingBottom: 2 },
  presetChip:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, borderWidth: 1.5, gap: 5 },
  presetIcon:        { fontSize: 15 },
  presetLabel:       { fontSize: 12, fontWeight: '600' },

  hint:              { fontSize: 10, textAlign: 'center', marginBottom: 5 },

  headerRow:         { flexDirection: 'row', paddingBottom: 4, borderBottomWidth: 1, marginBottom: 1 },
  dayCell:           { flex: 1, alignItems: 'center' },
  dayText:           { fontSize: 10, fontWeight: '700' },

  row:               { flexDirection: 'row', height: CELL_H },
  timeCell:          { width: TIME_W, justifyContent: 'center', alignItems: 'flex-end', paddingRight: 5 },
  timeText:          { fontSize: 8 },
  cell:              { flex: 1, height: CELL_H, borderRightWidth: 0.5, borderRightColor: 'rgba(0,0,0,0.06)' },
  bottomBorder:      { height: 1, marginLeft: TIME_W },

  summaryBox:        { marginTop: 10, padding: 10, borderRadius: 10 },
  summaryText:       { fontSize: 11, lineHeight: 18 },
  emptyText:         { fontSize: 12, textAlign: 'center', marginTop: 10 },
});
