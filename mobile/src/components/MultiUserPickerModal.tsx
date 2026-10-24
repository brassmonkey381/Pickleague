// Pick app users to invite (the invite code's "Send in app"). The user,
// 2026-10-24: "Suggest nearby, search all":
//   - with `nearScope`, the players who play near the league's home court /
//     the tournament's venue come first ("Plays at Lakeside Park · 2 mi"),
//     else those near the shared search area (lib/inviteSuggestions; league
//     courts only, the same rule as Discover);
//   - then everyone else by name, every page of discover_players, so typing a
//     name still finds anyone.
// A failed suggestions read only drops the suggestions; a failed everyone
// read shows the error (never an empty "No matches.").
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { isServerRefusal } from '../lib/refusals';
import { useTheme } from '../lib/ThemeContext';
import { AVATARS } from '../data/profileCustomization';
import { useSearchArea } from '../lib/useSearchArea';
import { searchAreaKey } from '../lib/searchArea';
import { playsAtLabel } from '../lib/playersNear';
import { firstWithAnyone, suggestedFirst, suggestionSteps } from '../lib/inviteSuggestions';
import { getInvitePlace, listEveryone, nearForInvite, type InviteScope } from '../data/inviteSuggestions';
import MultiSelectModal from './MultiSelectModal';
import { ErrorState } from '@just-messin-around/expo-foundation/ui';
import { FONT } from '@just-messin-around/expo-foundation/typography';

export type MultiPickedUser = {
  id: string;
  full_name: string;
  username: string;
  avatar_id: number | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
  /** Suggested players only: "Plays at Lakeside Park · 2 mi". */
  detail?: string | null;
};

type Props = {
  visible:         boolean;
  title:           string;
  ctaLabel?:       string;            // defaults to "Send {N} Invites"
  excludeUserIds?: string[];          // hide self / existing members
  /** The league or tournament the invite is for: its nearby players are suggested first. */
  nearScope?:      InviteScope;
  busy?:           boolean;
  onConfirm:       (users: MultiPickedUser[]) => void;
  onClose:         () => void;
};

const USER_COLUMNS = 'id, full_name, username, avatar_id, avatar_emoji, avatar_bg_color';

/** Pick app users (profiles). Chrome is provided by MultiSelectModal. */
/** Why the player list didn't load, and what to do. A server refusal already
 *  says both; anything else (offline, a server not updated yet) gets a retry hint. */
function loadProblem(e: unknown): string {
  if (isServerRefusal(e)) return friendlySbMessage(e);
  return `${friendlySbMessage(e, "Couldn't load players.")} Check your connection, then tap Try again.`;
}

export default function MultiUserPickerModal({
  visible, title, ctaLabel, excludeUserIds, nearScope, busy = false, onConfirm, onClose,
}: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const { area, saved, ready } = useSearchArea();
  const areaKey = searchAreaKey(area);

  const [users, setUsers]     = useState<MultiPickedUser[]>([]);
  const [loading, setLoading] = useState(true);
  // Why the list didn't load (null: it did): replaces the list, so a failed
  // read never looks like an empty search.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt]     = useState(0);

  // With a nearScope the list waits for the search area (lib/useSearchArea's
  // `ready`): the radius and the fallback centre come from it, and a list read
  // before it would be reordered under the user a moment later.
  const waiting = !!nearScope && !ready;

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setLoadError(null);
    if (waiting) return;
    let live = true;
    const exclude = excludeUserIds ?? [];
    // Nearby first; a failure here only drops the suggestions.
    const suggested = (async (): Promise<MultiPickedUser[]> => {
      if (!nearScope) return [];
      try {
        const place = await getInvitePlace(nearScope);
        const hit = await firstWithAnyone(
          suggestionSteps(place, area, saved.radiusMi),
          (step) => nearForInvite(step.circle, exclude),
        );
        return (hit?.rows ?? []).map((p) => ({
          id: p.id,
          full_name: p.full_name ?? 'Player',
          username: p.username ?? '',
          avatar_id: p.avatar_id,
          avatar_emoji: p.avatar_emoji,
          avatar_bg_color: p.avatar_bg_color,
          detail: playsAtLabel(p),
        }));
      } catch {
        return [];
      }
    })();
    // See UserPickerModal: discover_players leaves out tombstoned accounts
    // (and test accounts while God mode hides them); every page, so a name
    // past its 500-row cap is still found.
    Promise.all([listEveryone<MultiPickedUser>(USER_COLUMNS), suggested]).then(([everyone, near]) => {
      if (!live) return;
      setUsers(suggestedFirst(near, everyone));
      setLoading(false);
    }, (e: unknown) => {
      if (!live) return;
      setUsers([]);
      setLoadError(loadProblem(e));
      setLoading(false);
    });
    return () => { live = false; };
    // The area is read by its key; the exclusions are set before it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, waiting, attempt, nearScope?.type, nearScope?.id, areaKey, saved.radiusMi]);

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
        // loadProblem() already says what failed and what to do.
        <ErrorState
          iconName="warning"
          error={null}
          message={loadError}
          onRetry={() => setAttempt(n => n + 1)}
        />
      ) : null}
      searchPlaceholder={nearScope ? 'Search everyone by name or @username…' : 'Search by name or @username…'}
      searchText={u => `${u.full_name} ${u.username} @${u.username}`}
      toRow={u => {
        const cartoon = AVATARS.find(a => a.id === (u.avatar_id ?? 1)) ?? AVATARS[0];
        const emoji   = u.avatar_emoji ?? cartoon.emoji;
        const bg      = u.avatar_bg_color ?? cartoon.bgColor;
        return {
          id: u.id,
          primary: u.full_name,
          secondary: u.detail ? `@${u.username} · ${u.detail}` : `@${u.username}`,
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
    // The avatar emoji is the player's own picture (content, not chrome).
    avatarEmoji: { fontSize: FONT.size.h2 },
  });
}
