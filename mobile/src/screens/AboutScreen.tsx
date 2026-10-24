import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Constants from 'expo-constants';
import { Icon, type IconName } from '@just-messin-around/expo-foundation/icons';
import { Panel } from '@just-messin-around/expo-foundation/ui';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'About'> };

const VALUES: { icon: IconName; title: string; desc: string }[] = [
  { icon: 'smile',     title: 'Fun first',        desc: 'Great sport, great people, no drama.' },
  { icon: 'calendar',  title: 'Frequent play',    desc: 'Tools that make it easy to schedule and actually show up.' },
  { icon: 'scale',     title: 'Fair matchups',    desc: 'PLUPR ratings that put you against the right opponents.' },
  { icon: 'handshake', title: 'Community',        desc: 'Built for the groups and friendships that make pickleball great.' },
  { icon: 'chart',     title: 'Real improvement', desc: 'Track your game over time and see yourself get better.' },
];

export default function AboutScreen({}: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);

  return (
    <ScrollView style={S.screen} contentContainerStyle={S.container}>
      <Icon name="pickle" size={64} color={c.primary} style={S.logo} />
      <Text style={[t.display, S.center, S.appName]} accessibilityRole="header">Pickleague</Text>
      <Text style={[S.tagline, S.center]}>More fun. More frequent. More fair.</Text>

      <Panel padded={SPACE.lg} style={S.card}>
        <Text style={S.sectionTitle} accessibilityRole="header">Our Mission</Text>
        <Text style={S.body}>
          Pickleague exists to make recreational pickleball more fun, more frequent, and more fair — with the people you actually want to play with.
        </Text>
        <Text style={S.body}>
          We believe competitive play shouldn't require a club membership or a tournament entry fee. Every group of friends deserves a real league experience: standings that mean something, matches that are tracked, and rivals who keep you sharp.
        </Text>
      </Panel>

      <Panel padded={SPACE.lg} style={S.card}>
        <Text style={S.sectionTitle} accessibilityRole="header">Why We Were Built</Text>
        <Text style={S.body}>
          It started with a group of friends who loved pickleball but kept running into the same problems: Who do I play next? Is this a fair matchup? How do I actually get better?
        </Text>
        <Text style={S.body}>
          Scheduling happened over text. Results were forgotten by the following week. There was no way to track improvement, balance matchups, or settle the debate about who was actually the best in the group.
        </Text>
        <Text style={S.body}>
          Pickleague was built to solve all of that — bringing real league infrastructure to recreational players everywhere, without the bureaucracy of a formal club.
        </Text>
      </Panel>

      <Panel padded={SPACE.lg} style={S.card}>
        <Text style={S.sectionTitle} accessibilityRole="header">Our Values</Text>
        {VALUES.map(({ icon, title, desc }, i) => (
          <View key={title} style={[S.valueRow, i === VALUES.length - 1 && S.valueRowLast]}>
            {/* The entity-row tile: 32, rounded square, glyph 18. */}
            <View style={S.valueTile}>
              <Icon name={icon} size={18} color={c.primary} />
            </View>
            <View style={S.valueText}>
              <Text style={t.title}>{title}</Text>
              <Text style={[t.sub, S.valueDesc]}>{desc}</Text>
            </View>
          </View>
        ))}
      </Panel>

      <Text style={[t.hint, S.center, S.version]}>Pickleague v{Constants.expoConfig?.version ?? '—'}</Text>
      <Text style={[t.caption, S.center, S.credit]}>Made with love for recreational players everywhere</Text>
    </ScrollView>
  );
}

const TILE = 32;

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    screen:       { flex: 1, backgroundColor: c.bg },
    container:    { padding: SPACE.lg, paddingBottom: SPACE.xl * 2 },
    center:       { textAlign: 'center' },
    logo:         { alignSelf: 'center', marginTop: SPACE.sm },
    appName:      { marginTop: SPACE.sm },
    tagline:      { ...t.body, color: c.primary, fontWeight: FONT.weight.semibold, marginTop: SPACE.xs, marginBottom: SPACE.xl },
    card:         { marginBottom: SPACE.md },
    sectionTitle: { ...t.h3, marginBottom: SPACE.md },
    body:         { ...t.body, color: c.textSub, marginBottom: SPACE.sm },
    valueRow:     { flexDirection: 'row', alignItems: 'flex-start', marginBottom: SPACE.md, gap: SPACE.md },
    valueRowLast: { marginBottom: 0 },
    valueTile:    { width: TILE, height: TILE, borderRadius: RADIUS.md, backgroundColor: c.primaryLight, alignItems: 'center', justifyContent: 'center' },
    valueText:    { flex: 1, minWidth: 0 },
    valueDesc:    { marginTop: SPACE.xxs },
    version:      { marginTop: SPACE.lg },
    credit:       { marginTop: SPACE.xs },
  });
}
