import React, { useEffect, useState } from 'react';
import {
  Dimensions,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '../lib/ThemeContext';
import { TOURS, useTour } from '../lib/TourContext';

// Full-screen spotlight overlay. Rendered once at the app root by TourProvider's
// host (AppNavigator). It dims the page, cuts a highlight ring around the
// current step's measured target, and shows a tooltip with Next / Done.
//
// Robustness:
//  - When inactive, renders nothing (so it never intercepts taps).
//  - Measures via the registered ref's measureInWindow (works on web).
//  - If a step's anchor isn't mounted/measurable, it advances past it instead
//    of getting stuck.

type Rect = { x: number; y: number; w: number; h: number };

const RING_PAD = 8;     // padding around the measured target for the highlight
const TOOLTIP_W = 280;
const EDGE = 12;        // min margin from screen edges
const MEASURE_RETRY_MS = 120;

export default function SpotlightTour() {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const { activeTour, stepIndex, getAnchor, next, finish } = useTour();

  const [rect, setRect] = useState<Rect | null>(null);
  // Bump to re-trigger a measure attempt (e.g. retry while layout settles).
  const [measureTick, setMeasureTick] = useState(0);

  const steps = activeTour ? TOURS[activeTour] : [];
  const step = activeTour ? steps[stepIndex] : undefined;

  // Measure the current step's anchor whenever the active step changes.
  // If it can't be measured (anchor not mounted, zero-size), skip the step.
  useEffect(() => {
    if (!activeTour || !step) {
      setRect(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const anchor = getAnchor(activeTour, step.stepKey);
    const node = anchor?.current;

    if (!node || typeof node.measureInWindow !== 'function') {
      // No anchor for this step → advance past it on next tick.
      timer = setTimeout(() => { if (!cancelled) next(); }, 0);
      return () => { cancelled = true; if (timer) clearTimeout(timer); };
    }

    node.measureInWindow((x, y, w, h) => {
      if (cancelled) return;
      if (!w || !h) {
        // Not laid out yet — retry a couple of times before giving up.
        if (measureTick < 6) {
          timer = setTimeout(() => { if (!cancelled) setMeasureTick((n) => n + 1); }, MEASURE_RETRY_MS);
        } else {
          next();
        }
        return;
      }
      setRect({ x, y, w, h });
    });

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [activeTour, step, stepIndex, getAnchor, next, measureTick]);

  // Reset the retry counter + clear stale geometry when the step changes, so
  // we never render the previous target's ring under the new tooltip.
  useEffect(() => { setMeasureTick(0); setRect(null); }, [stepIndex, activeTour]);

  if (!activeTour || !step || !rect) return null;

  const isLast = stepIndex >= steps.length - 1;
  const { width: screenW, height: screenH } = Dimensions.get('window');

  // Ring geometry (target rect padded out).
  const ring = {
    left: rect.x - RING_PAD,
    top: rect.y - RING_PAD,
    width: rect.w + RING_PAD * 2,
    height: rect.h + RING_PAD * 2,
  };

  // Place the tooltip below the target if there's room, otherwise above.
  const ringBottom = ring.top + ring.height;
  const spaceBelow = screenH - ringBottom;
  const placeBelow = spaceBelow > 160;
  const tooltipTop = placeBelow ? ringBottom + 12 : Math.max(EDGE, ring.top - 150);
  // Center horizontally over the target, clamped to the screen.
  let tooltipLeft = ring.left + ring.width / 2 - TOOLTIP_W / 2;
  tooltipLeft = Math.max(EDGE, Math.min(tooltipLeft, screenW - TOOLTIP_W - EDGE));

  // On web the overlay must be position:fixed to cover the viewport (RN's
  // type system doesn't know 'fixed', so it's cast in).
  const fixedOnWeb = Platform.OS === 'web' ? ({ position: 'fixed' } as any) : null;

  return (
    <View style={[S.overlay, fixedOnWeb]} pointerEvents="box-none">
      {/* Dim backdrop — four panels around the highlight so the target stays
          un-dimmed. Tapping the backdrop dismisses the tour. */}
      <Pressable style={[S.dim, { left: 0, top: 0, right: 0, height: Math.max(ring.top, 0) }]} onPress={finish} />
      <Pressable style={[S.dim, { left: 0, top: ringBottom, right: 0, bottom: 0 }]} onPress={finish} />
      <Pressable style={[S.dim, { left: 0, top: Math.max(ring.top, 0), width: Math.max(ring.left, 0), height: ring.height }]} onPress={finish} />
      <Pressable style={[S.dim, { left: ring.left + ring.width, top: Math.max(ring.top, 0), right: 0, height: ring.height }]} onPress={finish} />

      {/* Highlight ring around the target (non-interactive). */}
      <View
        pointerEvents="none"
        style={[
          S.ring,
          { left: ring.left, top: ring.top, width: ring.width, height: ring.height },
        ]}
      />

      {/* Tooltip bubble */}
      <View style={[S.tooltip, { left: tooltipLeft, top: tooltipTop }]}>
        <Text style={S.counter}>{stepIndex + 1}/{steps.length}</Text>
        <Text style={S.title}>{step.title}</Text>
        <Text style={S.body}>{step.body}</Text>
        <View style={S.tooltipFooter}>
          <TouchableOpacity onPress={finish} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={S.skip}>Skip</Text>
          </TouchableOpacity>
          <TouchableOpacity style={S.nextBtn} onPress={isLast ? finish : next} activeOpacity={0.85}>
            <Text style={S.nextBtnText}>{isLast ? 'Done' : 'Next →'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    overlay: {
      position: 'absolute',
      left: 0, top: 0, right: 0, bottom: 0,
      zIndex: 99999,
    },
    dim: {
      position: 'absolute',
      backgroundColor: 'rgba(0,0,0,0.62)',
    },
    ring: {
      position: 'absolute',
      borderRadius: 14,
      borderWidth: 3,
      borderColor: c.primary,
    },
    tooltip: {
      position: 'absolute',
      width: 280,
      backgroundColor: c.surface,
      borderRadius: 14,
      padding: 16,
      borderWidth: 1,
      borderColor: c.border,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    counter: { fontSize: 11, fontWeight: '700', color: c.textMuted, marginBottom: 4, letterSpacing: 0.5 },
    title: { fontSize: 16, fontWeight: '800', color: c.text, marginBottom: 6 },
    body: { fontSize: 13, color: c.textSub, lineHeight: 19, marginBottom: 14 },
    tooltipFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    skip: { fontSize: 13, color: c.textMuted, fontWeight: '600' },
    nextBtn: { backgroundColor: c.primary, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 20 },
    nextBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  });
}
