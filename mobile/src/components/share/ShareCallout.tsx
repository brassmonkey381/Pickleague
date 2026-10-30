// The big, centered way into a share card (PKL-013): a tinted panel with a
// headline, one line, and a full-width primary button. Screens show it only
// when isImageShareAvailable().
import React from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';

type Props = {
  title: string;
  line?: string;
  buttonTitle: string;
  onPress: () => void;
  /** A second share under it (an outline button). */
  secondary?: { title: string; onPress: () => void } | null;
  style?: StyleProp<ViewStyle>;
};

export default function ShareCallout({ title, line, buttonTitle, onPress, secondary, style }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  return (
    <View style={[S.box, { backgroundColor: c.primaryLight, borderColor: c.primary }, style]}>
      <Text style={[t.h3, S.center]}>{title}</Text>
      {line ? <Text style={[t.sub, S.center, { color: c.textSub }]}>{line}</Text> : null}
      <Button title={buttonTitle} iconName="share" onPress={onPress} style={S.btn} />
      {secondary ? <Button title={secondary.title} variant="outline" onPress={secondary.onPress} style={S.btn} /> : null}
    </View>
  );
}

const S = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACE.lg, gap: SPACE.sm, alignItems: 'center' },
  center: { textAlign: 'center' },
  btn: { alignSelf: 'stretch', marginTop: SPACE.xs },
});
