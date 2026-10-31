// PLUPR over time: one line, the rating after each match (lib/ratingHistory).
// Tap or drag across it to read a match's rating and date; with nothing
// picked the header shows the latest rating and the change across the range.
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, type LayoutChangeEvent, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { chartScale, nearestIndex, type RatingPoint } from '../lib/ratingHistory';

const HEIGHT = 120;
/** Room inside the plot so the 8px end marker isn't clipped. */
const INSET = 6;

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function RatingHistoryChart({ points }: { points: readonly RatingPoint[] }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);

  const plotW = Math.max(0, width - INSET * 2);
  const plotH = HEIGHT - INSET * 2;
  const scale = useMemo(() => chartScale(points, plotW, plotH), [points, plotW, plotH]);

  const first = points[0];
  const last = points[points.length - 1];
  const shown = picked != null ? points[picked] : last;
  const change = last.rating - first.rating;
  const changeText = `${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(2)}`;

  function pick(e: GestureResponderEvent) {
    if (scale.xy.length === 0) return;
    setPicked(nearestIndex(scale.xy, e.nativeEvent.locationX - INSET));
  }

  const linePts = scale.xy.map((p) => `${p.x + INSET},${p.y + INSET}`).join(' ');
  const mark = picked != null ? scale.xy[picked] : scale.xy[scale.xy.length - 1];

  return (
    <View style={S.card} accessibilityLabel={`PLUPR over ${points.length} matches, from ${first.rating.toFixed(2)} to ${last.rating.toFixed(2)}`}>
      <View style={S.head}>
        <Text style={t.fieldLabel}>PLUPR over time</Text>
        <Text style={t.hint}>
          {picked != null
            ? shortDate(shown.at)
            : `${changeText} over ${points.length} matches`}
        </Text>
      </View>
      <Text style={S.value}>{shown.rating.toFixed(2)}</Text>

      <View
        style={S.plot}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={pick}
        onResponderMove={pick}
        onResponderRelease={() => setPicked(null)}
        onResponderTerminate={() => setPicked(null)}
      >
        {width > 0 && (
          <Svg width={width} height={HEIGHT}>
            {/* Recessive guides at the top and bottom of the range. */}
            <Line x1={0} x2={width} y1={INSET} y2={INSET} stroke={c.border} strokeWidth={1} />
            <Line x1={0} x2={width} y1={HEIGHT - INSET} y2={HEIGHT - INSET} stroke={c.border} strokeWidth={1} />
            {picked != null && mark && (
              <Line x1={mark.x + INSET} x2={mark.x + INSET} y1={0} y2={HEIGHT} stroke={c.textMuted} strokeWidth={1} />
            )}
            <Polyline
              points={linePts}
              fill="none"
              stroke={c.primary}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {mark && (
              <Circle cx={mark.x + INSET} cy={mark.y + INSET} r={4} fill={c.primary} stroke={c.surface} strokeWidth={2} />
            )}
          </Svg>
        )}
      </View>

      <View style={S.foot}>
        <Text style={t.hint}>{shortDate(first.at)}</Text>
        <Text style={t.hint}>{shortDate(last.at)}</Text>
      </View>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    card:  { backgroundColor: c.surface, borderRadius: RADIUS.lg, borderWidth: HAIRLINE, borderColor: c.border, padding: SPACE.md, marginBottom: SPACE.md },
    head:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
    value: { ...t.h2, marginTop: SPACE.xxs, marginBottom: SPACE.sm },
    plot:  { height: HEIGHT },
    foot:  { flexDirection: 'row', justifyContent: 'space-between', marginTop: SPACE.xs },
  });
}
