// The player standing in their My Place: their avatar as the app draws it
// everywhere (photo, else the premium or cartoon emoji on its colour) as a
// round head over a soft body in the avatar's colour. Fills the avatar
// slot's box (aspect 0.8, a little taller than wide), feet on its bottom edge.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CachedImage } from '@just-messin-around/expo-foundation/ui/CachedImage';
import { shade } from '@just-messin-around/expo-foundation/room/art';
import type { Box } from '@just-messin-around/expo-foundation/room/layout';
import type { AvatarLook } from '../../lib/myPlace';

type Props = { box: Box; look: AvatarLook; label?: string };

export default function MyPlaceAvatar({ box, look, label }: Props) {
  const head = Math.min(box.width * 0.86, box.height * 0.6);
  const bodyW = head * 0.92;
  const bodyH = Math.max(4, box.height - head * 0.78);
  const bodyColor = safeShade(look.bgColor, -0.18);
  return (
    <View
      style={[styles.wrap, { width: box.width, height: box.height }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
    >
      <View
        style={[
          styles.shadow,
          { width: box.width * 0.9, height: Math.max(3, box.height * 0.07), borderRadius: box.width, bottom: -box.height * 0.02 },
        ]}
      />
      <View
        style={{
          position: 'absolute',
          bottom: 0,
          width: bodyW,
          height: bodyH,
          borderTopLeftRadius: bodyW / 2,
          borderTopRightRadius: bodyW / 2,
          borderBottomLeftRadius: bodyW * 0.18,
          borderBottomRightRadius: bodyW * 0.18,
          backgroundColor: bodyColor,
        }}
      />
      <View
        style={[
          styles.head,
          {
            width: head,
            height: head,
            borderRadius: head / 2,
            bottom: bodyH - head * 0.22,
            backgroundColor: look.bgColor,
            borderWidth: Math.max(1, head * 0.05),
            borderColor: safeShade(look.bgColor, 0.25),
          },
        ]}
      >
        {look.photoUrl ? (
          <CachedImage source={{ uri: look.photoUrl }} style={{ width: head, height: head }} />
        ) : (
          <Text style={{ fontSize: head * 0.56, lineHeight: head * 0.72 }} maxFontSizeMultiplier={1} allowFontScaling={false}>
            {look.emoji}
          </Text>
        )}
      </View>
    </View>
  );
}

/** shade() wants #rrggbb; anything else keeps its colour. */
function safeShade(hex: string, pct: number): string {
  return /^#[0-9a-f]{6}$/i.test(hex) ? shade(hex, pct) : hex;
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'flex-end' },
  shadow: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.16)' },
  head: { position: 'absolute', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
});
