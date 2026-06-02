import React, { useEffect, useState } from 'react';
import { TouchableOpacity, Text, StyleProp, ViewStyle, TextStyle } from 'react-native';
import { addBookmark, removeBookmark, isBookmarked, BookmarkTargetType } from '../lib/bookmarks';

type Props = {
  targetType: BookmarkTargetType;
  targetId: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
};

export default function BookmarkButton({ targetType, targetId, size = 22, style, textStyle }: Props) {
  const [on, setOn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    isBookmarked(targetType, targetId).then(b => { if (!cancelled) setOn(b); });
    return () => { cancelled = true; };
  }, [targetType, targetId]);

  async function toggle() {
    if (on === null) return;
    const next = !on;
    setOn(next);
    const ok = next
      ? await addBookmark(targetType, targetId)
      : await removeBookmark(targetType, targetId);
    if (!ok) setOn(!next);
  }

  return (
    <TouchableOpacity
      onPress={toggle}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      style={style}
      accessibilityRole="button"
      accessibilityLabel={on ? 'Remove bookmark' : 'Add bookmark'}
    >
      <Text style={[{ fontSize: size, opacity: on === false ? 0.35 : 1 }, textStyle]}>🔖</Text>
    </TouchableOpacity>
  );
}
