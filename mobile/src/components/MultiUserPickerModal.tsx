import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { AVATARS } from '../data/profileCustomization';
import MultiSelectModal from './MultiSelectModal';

export type MultiPickedUser = {
  id: string;
  full_name: string;
  username: string;
  avatar_id: number | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
};

type Props = {
  visible:         boolean;
  title:           string;
  ctaLabel?:       string;            // defaults to "Send {N} Invites"
  excludeUserIds?: string[];          // hide self / existing members
  busy?:           boolean;
  onConfirm:       (users: MultiPickedUser[]) => void;
  onClose:         () => void;
};

/** Pick app users (profiles). Chrome is provided by MultiSelectModal. */
export default function MultiUserPickerModal({
  visible, title, ctaLabel, excludeUserIds, busy = false, onConfirm, onClose,
}: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [users, setUsers]     = useState<MultiPickedUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    supabase
      .from('profiles')
      .select('id, full_name, username, avatar_id, avatar_emoji, avatar_bg_color')
      .order('full_name')
      .limit(500)
      .then(({ data }) => {
        setUsers((data ?? []) as MultiPickedUser[]);
        setLoading(false);
      });
  }, [visible]);

  const exclude = useMemo(() => new Set(excludeUserIds ?? []), [excludeUserIds]);
  const items = useMemo(() => users.filter(u => !exclude.has(u.id)), [users, exclude]);

  return (
    <MultiSelectModal<MultiPickedUser>
      visible={visible}
      title={title}
      items={items}
      loading={loading}
      busy={busy}
      searchPlaceholder="Search by name or @username…"
      searchText={u => `${u.full_name} ${u.username}`}
      toRow={u => {
        const cartoon = AVATARS.find(a => a.id === (u.avatar_id ?? 1)) ?? AVATARS[0];
        const emoji   = u.avatar_emoji ?? cartoon.emoji;
        const bg      = u.avatar_bg_color ?? cartoon.bgColor;
        return {
          id: u.id,
          primary: u.full_name,
          secondary: `@${u.username}`,
          left: (
            <View style={[S.avatar, { backgroundColor: bg }]}>
              <Text style={S.avatarEmoji}>{emoji}</Text>
            </View>
          ),
        };
      }}
      ctaLabel={count =>
        ctaLabel ?? (count === 0 ? 'Pick at least one' : `Send ${count} Invite${count === 1 ? '' : 's'}`)
      }
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    avatar:      { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
    avatarEmoji: { fontSize: 20 },
  });
}
