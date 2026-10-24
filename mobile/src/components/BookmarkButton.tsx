import React, { useEffect, useState } from 'react';
import { TouchableOpacity, StyleProp, ViewStyle, TextStyle } from 'react-native';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { useTheme } from '../lib/ThemeContext';
import { addBookmark, removeBookmark, isBookmarked, BookmarkTargetType } from '../lib/bookmarks';

type Props = {
  targetType: BookmarkTargetType;
  targetId: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
  /** @deprecated The bookmark is a glyph now; kept so existing call sites compile. */
  textStyle?: StyleProp<TextStyle>;
};

export default function BookmarkButton({ targetType, targetId, size = 22, style }: Props) {
  const { colors: c } = useTheme();
  // null = we don't know yet (loading, or the read failed). Never guessed as
  // `false`: showing an un-bookmarked icon for a saved item makes the user
  // "re-add" it and wonder why nothing happens.
  const [on, setOn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    isBookmarked(targetType, targetId)
      .then(b => { if (!cancelled) setOn(b); })
      .catch(() => { if (!cancelled) setOn(null); });
    return () => { cancelled = true; };
  }, [targetType, targetId]);

  async function toggle() {
    // Unknown state: a tap re-attempts the read rather than doing nothing
    // forever after one failed load.
    if (on === null) {
      try {
        setOn(await isBookmarked(targetType, targetId));
      } catch {
        // Still unreachable — leave it indeterminate.
      }
      return;
    }
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
      accessibilityLabel={on === true ? 'Remove bookmark' : on === false ? 'Add bookmark' : 'Bookmark, checking'}
    >
      {/* Saved: the filled ribbon in the brand colour. Not saved: the outline
          in the muted grey. Not known yet (loading, or the read failed): the
          filled ribbon in grey, so it never claims "not saved" for an item
          that may be saved (the rule above). */}
      <Icon name={on === false ? 'bookmark-outline' : 'bookmark'} size={size} color={on ? c.primary : c.textMuted} />
    </TouchableOpacity>
  );
}
