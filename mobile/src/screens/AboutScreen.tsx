import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { gs } from '../lib/globalStyles';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'About'> };

export default function AboutScreen({}: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  return (
    <ScrollView contentContainerStyle={S.container}>
      <Text style={S.logo}>🥒</Text>
      <Text style={S.appName}>Pickleague</Text>
      <Text style={S.tagline}>More fun. More frequent. More fair.</Text>

      <View style={S.card}>
        <Text style={S.sectionTitle}>Our Mission</Text>
        <Text style={S.body}>
          Pickleague exists to make recreational pickleball more fun, more frequent, and more fair — with the people you actually want to play with.
        </Text>
        <Text style={S.body}>
          We believe competitive play shouldn't require a club membership or a tournament entry fee. Every group of friends deserves a real league experience: standings that mean something, matches that are tracked, and rivals who keep you sharp.
        </Text>
      </View>

      <View style={S.card}>
        <Text style={S.sectionTitle}>Why We Were Built</Text>
        <Text style={S.body}>
          It started with a group of friends who loved pickleball but kept running into the same problems: Who do I play next? Is this a fair matchup? How do I actually get better?
        </Text>
        <Text style={S.body}>
          Scheduling happened over text. Results were forgotten by the following week. There was no way to track improvement, balance matchups, or settle the debate about who was actually the best in the group.
        </Text>
        <Text style={S.body}>
          Pickleague was built to solve all of that — bringing real league infrastructure to recreational players everywhere, without the bureaucracy of a formal club.
        </Text>
      </View>

      <View style={S.card}>
        <Text style={S.sectionTitle}>Our Values</Text>
        {[
          { icon: '😄', title: 'Fun first',       desc: 'Great sport, great people, no drama.' },
          { icon: '📅', title: 'Frequent play',   desc: 'Tools that make it easy to schedule and actually show up.' },
          { icon: '⚖️', title: 'Fair matchups',   desc: 'ELO ratings that put you against the right opponents.' },
          { icon: '🤝', title: 'Community',       desc: 'Built for the groups and friendships that make pickleball great.' },
          { icon: '📈', title: 'Real improvement', desc: 'Track your game over time and see yourself get better.' },
        ].map(({ icon, title, desc }) => (
          <View key={title} style={S.valueRow}>
            <Text style={S.valueIcon}>{icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={S.valueTitle}>{title}</Text>
              <Text style={S.valueDesc}>{desc}</Text>
            </View>
          </View>
        ))}
      </View>

      <Text style={S.version}>Pickleague v1.0.0</Text>
      <Text style={S.credit}>Made with love for recreational players everywhere</Text>
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:    { padding: 24, backgroundColor: c.bg, paddingBottom: 48 },
    logo:         { fontSize: 64, textAlign: 'center', marginTop: 8 },
    appName:      { fontSize: 32, fontWeight: '800', color: c.text, textAlign: 'center', marginTop: 8 },
    tagline:      { fontSize: 16, color: c.primary, fontWeight: '600', textAlign: 'center', marginTop: 4, marginBottom: 28 },
    card: {
      backgroundColor: c.surface,
      borderRadius: 14,
      padding: 18,
      marginBottom: 16,
      shadowColor: '#000',
      shadowOpacity: 0.07,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 3,
    },
    sectionTitle: { fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 12 },
    body:         { fontSize: 15, color: c.textSub, lineHeight: 23, marginBottom: 10 },
    valueRow:     { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 14, gap: 12 },
    valueIcon:    { fontSize: 24, width: 32, textAlign: 'center' },
    valueTitle:   { fontSize: 14, fontWeight: '700', color: c.text },
    valueDesc:    { fontSize: 13, color: c.textSub, marginTop: 2 },
    version:      { textAlign: 'center', color: c.textMuted, fontSize: 13, marginTop: 16 },
    credit:       { textAlign: 'center', color: c.textMuted, fontSize: 12, marginTop: 4 },
  });
}
