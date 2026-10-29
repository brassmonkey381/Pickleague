// Me › Play history (PKL-011): the same one-line strip row as Profile's
// Friends and My routine. Opens PlayHistoryScreen.
import React from 'react';
import { StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ListCard } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import type { RootStackParamList } from '../../types';

/** The strip row's height: the same as Profile's other strip rows. */
const ROW_HEIGHT = 48;

export default function PlayHistoryLink({ style }: { style?: StyleProp<ViewStyle> }) {
  const { colors: c } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <ListCard
      density="compact"
      minHeight={ROW_HEIGHT}
      style={style}
      leading={<Icon name="clock" size={18} color={c.primary} />}
      title={<Text style={[S.label, { color: c.text }]} numberOfLines={1}>Play history</Text>}
      chevron
      onPress={() => navigation.navigate('PlayHistory')}
      accessibilityRole="button"
      accessibilityLabel="Play history"
    />
  );
}

const S = StyleSheet.create({
  label: { fontSize: FONT.size.base, fontWeight: FONT.weight.semibold },
});
