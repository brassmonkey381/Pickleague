// A badge earned shows as a celebration card in the kit's notice stack (one
// safe-area-aware top slot, kit 1.128) instead of its own overlay at a
// different offset. View opens Achievements with that badge's sheet open.
// Renders nothing itself; mount it inside the ToastProvider.
import React, { useEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { EmojiGlyph } from '@just-messin-around/expo-foundation/icons';
import { useToast } from '@just-messin-around/expo-foundation/toast';
import { edgeColor, medalColor } from '@just-messin-around/expo-foundation/theme';
import { useTheme } from '../lib/ThemeContext';
import { useBadgeNotifications } from '../lib/useBadgeNotifications';
import { navigateWhenReady } from '../lib/navigationRef';

export default function BadgeToast() {
  const { toasts, dismissToast } = useBadgeNotifications();
  const toast = useToast();
  const { colors: c } = useTheme();
  const shown = useRef(new Set<string>());

  useEffect(() => {
    for (const t of toasts) {
      if (shown.current.has(t.id)) continue;
      shown.current.add(t.id);
      toast.celebrate({
        kicker: 'Badge earned',
        title: t.name,
        text: 'Added to your achievements.',
        art: (
          <View style={[S.medal, { backgroundColor: medalColor(c, 1), borderColor: edgeColor(c) }]}>
            <EmojiGlyph emoji={t.icon} size={24} color={edgeColor(c)} />
          </View>
        ),
        action: { label: 'View', onPress: () => navigateWhenReady('Achievements', { focus: t.badgeId }) },
      });
      // The kit stack owns its time on screen now.
      dismissToast(t.id);
    }
  }, [toasts, toast, dismissToast, c]);

  return null;
}

const S = StyleSheet.create({
  medal: { width: 52, height: 52, borderRadius: 26, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
