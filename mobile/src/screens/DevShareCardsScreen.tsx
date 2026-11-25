// PKL-092 DEV-ONLY: every Godmode lab tournament story in the four layouts, each in its mock look (A Court, B Night,
// C Ball, D Cream), at the studio's post size, so a script can screenshot them on the web (the share studio itself
// is native-only). Registered only when __DEV__, at /dev/share-cards. No sign-in, no reads or writes.
import React from 'react';
import { ScrollView, View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../lib/ThemeContext';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import TournamentStoryArt from '../components/share/TournamentStoryArt';
import { SHARE_LOOKS } from '../lib/shareCards';
import { labStories } from '../lib/tournamentShareLab';

const W = 300, H = 375;
const LAYOUTS = [
  { id: 'tour-scorecard', label: 'A Scorecard', look: 'court' },
  { id: 'tour-bracket', label: 'B Bracket', look: 'night' },
  { id: 'tour-poster', label: 'C Poster', look: 'ball' },
  { id: 'tour-photo', label: 'D Team photo (no photo)', look: 'cream' },
] as const;

export default function DevShareCardsScreen() {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={st.page}>
      {labStories().map((x) => (
        <View key={x.id} testID={`share-${x.id}`} style={[st.group, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={t.title}>{x.label}</Text>
          <View style={st.grid}>
            {LAYOUTS.map((l) => (
              <View key={l.id} style={{ gap: 4 }}>
                <Text style={t.label}>{l.label}</Text>
                <View style={{ width: W, height: H, borderRadius: 12, overflow: 'hidden' }}>
                  <TournamentStoryArt story={x.story} template={l.id} look={SHARE_LOOKS[l.look]} width={W} height={H}
                    story916={false} photo={null} logo="full" />
                </View>
              </View>
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  page: { padding: 16, gap: 16, alignItems: 'center' },
  group: { padding: 12, borderWidth: 1, borderRadius: 12, gap: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, maxWidth: 4 * W + 3 * 12 },
});
