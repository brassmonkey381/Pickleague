// First run's band art (PKL-031 R05): a court with a paddle, a ball and a
// score bubble for Welcome; two mock alerts for Alerts; a court with starred
// pins for Your courts. Drawn in the Look's colours; decorative only (the
// kit's FirstRunSteps hides the hero from screen readers).
import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';
import { edgeColor, highlightColors } from '@just-messin-around/expo-foundation/theme';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';

const ICON = require('../../../assets/icon.png');
const COURT_GREEN = '#2f6b45';

function Court({ children }: { children?: React.ReactNode }) {
  const { colors: c } = useTheme();
  const edge = edgeColor(c);
  return (
    <Svg width={260} height={160} viewBox="0 0 260 160">
      <Rect x={4} y={14} width={252} height={142} rx={12} fill={COURT_GREEN} stroke={edge} strokeWidth={4} />
      <Line x1={70} y1={14} x2={70} y2={156} stroke="#ffffff" strokeWidth={3} />
      <Line x1={190} y1={14} x2={190} y2={156} stroke="#ffffff" strokeWidth={3} />
      <Line x1={130} y1={14} x2={130} y2={156} stroke="#ffffff" strokeWidth={3} />
      <Line x1={4} y1={85} x2={256} y2={85} stroke="#ffffff" strokeWidth={3} strokeDasharray="10 6" />
      {children}
    </Svg>
  );
}

export function WelcomeArt() {
  const { colors: c } = useTheme();
  const edge = edgeColor(c);
  const hl = highlightColors(c);
  const t = textStyles(c);
  return (
    <View style={S.wrap}>
      <Court>
        {/* Paddle */}
        <G rotation={-28} origin="70, 80">
          <Rect x={60} y={86} width={14} height={46} rx={6} fill={edge} />
          <Rect x={44} y={34} width={46} height={58} rx={22} fill={hl.bg} stroke={edge} strokeWidth={4} />
        </G>
        {/* Ball */}
        <Circle cx={196} cy={60} r={22} fill="#ffffff" stroke={edge} strokeWidth={4} />
        {[[188, 52], [204, 52], [196, 62], [188, 70], [204, 70]].map(([x, y], i) => (
          <Circle key={i} cx={x} cy={y} r={3.5} fill={edge} />
        ))}
        <Path d="M172 36 l-6 -8 M180 30 l-2 -10 M164 46 l-10 -4" stroke={edge} strokeWidth={3} strokeLinecap="round" />
      </Court>
      <View style={[S.score, { backgroundColor: c.surface, borderColor: edge }]}>
        <Text style={[t.h2, { color: edge }]}>11 – 9</Text>
      </View>
    </View>
  );
}

export function CourtsArt() {
  const { colors: c } = useTheme();
  const edge = edgeColor(c);
  const hl = highlightColors(c);
  const pin = (x: number, y: number, on: boolean, key: number) => (
    <G key={key}>
      <Path
        d={`M${x} ${y + 26} C ${x - 4} ${y + 16}, ${x - 16} ${y + 10}, ${x - 16} ${y} A 16 16 0 1 1 ${x + 16} ${y} C ${x + 16} ${y + 10}, ${x + 4} ${y + 16}, ${x} ${y + 26} Z`}
        fill={on ? hl.bg : '#ffffff'}
        stroke={edge}
        strokeWidth={3.5}
      />
      <Path
        d={`M${x} ${y - 8} l2.6 5.4 5.9 .8 -4.3 4.1 1 5.8 -5.2 -2.8 -5.2 2.8 1 -5.8 -4.3 -4.1 5.9 -.8z`}
        fill={on ? edge : 'none'}
        stroke={edge}
        strokeWidth={1.5}
      />
    </G>
  );
  return (
    <View style={S.wrap}>
      <Court>
        {pin(70, 48, true, 1)}
        {pin(190, 64, true, 2)}
        {pin(130, 112, false, 3)}
      </Court>
    </View>
  );
}

function MockAlert({ title, body, when, dim }: { title: string; body: string; when: string; dim?: boolean }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  return (
    <View
      style={[
        S.alert,
        { backgroundColor: dim ? c.primaryLight : c.surface },
        dim ? S.alertBack : null,
      ]}
    >
      <Image source={ICON} style={S.alertIcon} />
      <View style={S.flex}>
        <View style={S.alertHead}>
          <Text style={[t.sub, S.bold, { color: c.text }]}>Pickleague</Text>
          <Text style={[t.meta, { color: c.textSub }]}>{when}</Text>
        </View>
        <Text style={[t.sub, S.bold, { color: c.text }]}>{title}</Text>
        <Text style={[t.sub, { color: c.text }]} numberOfLines={2}>{body}</Text>
      </View>
    </View>
  );
}

export function AlertsArt() {
  return (
    <View style={S.alerts}>
      <MockAlert title="Sam invited you to doubles" body="Sat 9:00 AM at Riverside Courts. Tap to accept." when="now" />
      <MockAlert title="Confirm your score: 11-9" body="Unconfirmed matches drop after an hour." when="2m ago" dim />
    </View>
  );
}

const S = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', paddingTop: 20 },
  score: {
    position: 'absolute', top: 0, right: 8, borderWidth: 3, borderRadius: 14,
    paddingHorizontal: 16, paddingVertical: 4,
  },
  alerts: { alignSelf: 'stretch', gap: 12, paddingTop: 4 },
  alert: { flexDirection: 'row', gap: 12, borderRadius: 18, padding: 14, alignItems: 'flex-start' },
  alertBack: { marginHorizontal: 8 },
  alertIcon: { width: 36, height: 36, borderRadius: 9 },
  alertHead: { flexDirection: 'row', justifyContent: 'space-between' },
  bold: { fontWeight: '800' },
  flex: { flex: 1, minWidth: 0 },
});
