// The Play / Leagues / Tournaments header-right "+" (plan section 4: create
// actions move off the list into a header ActionSheet). Its own 44x44 box:
// hitSlop doesn't count, react-native-web's Pressable ignores it.
import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { useTheme } from '../../lib/ThemeContext';

export default function HeaderPlusButton({ onPress, accessibilityLabel }: {
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const { colors: c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.box, pressed && styles.pressed]}
    >
      <Icon name="plus" size={24} color={c.primary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
});

/**
 * Put the "+" in the stack header while `live` (this list is focused AND its
 * Play tab is the one showing). Play mounts both lists on one `navigation`, so
 * whichever is live owns the header button; the standalone Leagues /
 * Tournaments routes are always live.
 */
export function usePlayHeaderPlus(
  navigation: { setOptions: (options: { headerRight?: () => React.ReactNode }) => void },
  live: boolean,
  accessibilityLabel: string,
  onPress: () => void,
): void {
  const pressRef = React.useRef(onPress);
  pressRef.current = onPress;
  React.useLayoutEffect(() => {
    if (!live) return;
    navigation.setOptions({
      headerRight: () => (
        <HeaderPlusButton onPress={() => pressRef.current()} accessibilityLabel={accessibilityLabel} />
      ),
    });
  }, [live, navigation, accessibilityLabel]);
}
