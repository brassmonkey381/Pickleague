import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { isServerRefusal } from '../lib/refusals';
import { useTheme } from '../lib/ThemeContext';
import { AVATARS } from '../data/profileCustomization';
import MultiSelectModal from './MultiSelectModal';
import EmptyState from './EmptyState';

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
/** Why the player list didn't load, and what to do. A server refusal already
 *  says both; anything else (offline, a server not updated yet) gets a retry hint. */
function loadProblem(e: unknown): string {
  if (isServerRefusal(e)) return friendlySbMessage(e);
  return `${friendlySbMessage(e, "Couldn't load players.")} Check your connection, then tap Try again.`;
}

export default function MultiUserPickerModal({
  visible, title, ctaLabel, excludeUserIds, busy = false, onConfirm, onClose,
}: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [users, setUsers]     = useState<MultiPickedUser[]>([]);
  const [loading, setLoading] = useState(true);
  // Why the list didn't load (null: it did): replaces the list, so a failed
  // read never looks like an empty search.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt]     = useState(0);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setLoading(true);
    setLoadError(null);
    // See UserPickerModal: discover_players leaves out tombstoned accounts
    // (and test accounts while God mode hides them), by name, at most 500.
    supabase
      .rpc('discover_players')
      .select('id, full_name, username, avatar_id, avatar_emoji, avatar_bg_color')
      .then(({ data, error }) => {
        if (!live) return;
        if (error) {
          setUsers([]);
          setLoadError(loadProblem(error));
        } else {
          setUsers((data ?? []) as MultiPickedUser[]);
        }
        setLoading(false);
      }, (e: unknown) => {
        if (!live) return;
        setUsers([]);
        setLoadError(loadProblem(e));
        setLoading(false);
      });
    return () => { live = false; };
  }, [visible, attempt]);

  const exclude = useMemo(() => new Set(excludeUserIds ?? []), [excludeUserIds]);
  const items = useMemo(() => users.filter(u => !exclude.has(u.id)), [users, exclude]);

  return (
    <MultiSelectModal<MultiPickedUser>
      visible={visible}
      title={title}
      items={items}
      loading={loading}
      busy={busy}
      notice={loadError ? (
        <EmptyState
          icon="⚠️"
          title="Couldn't load players."
          subtitle={loadError}
          actionLabel="Try again"
          onAction={() => setAttempt(n => n + 1)}
        />
      ) : null}
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
