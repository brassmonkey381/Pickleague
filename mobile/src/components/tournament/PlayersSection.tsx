// Players (n/max), plan section 5: collapsed by default, with an AvatarPile
// as the collapsed summary; open, one 44px row per player that opens their
// profile. Approved players plus outstanding invites (the people the
// tournament is filling its roster with); join requests stay in Manage.
// Organizers get "Roles" in the header (TournamentMembers). Replaces
// RosterSection (P5a).
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { AvatarPile, Chip } from '@just-messin-around/expo-foundation/ui';
import { HAIRLINE, RADIUS, SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { Tournament, TournamentRegistration } from '../../types';
import { tournamentRoleLabel, type TournamentRole } from '../../lib/tournamentRole';
import { formatPlupr } from '../../lib/plupr';
import FlairName from '../FlairName';
import SectionCard from './SectionCard';
import type { TournamentDetailNavigation } from './useTournamentDetail';

export default function PlayersSection({
  navigation, tournament, tournamentId, rosterShown, isPriv, open, onToggle,
}: {
  navigation: TournamentDetailNavigation;
  tournament: Tournament;
  tournamentId: string;
  rosterShown: TournamentRegistration[];
  isPriv: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const count = tournament.max_players ? `${rosterShown.length}/${tournament.max_players}` : rosterShown.length;

  const pile = (
    <AvatarPile
      items={rosterShown}
      keyOf={r => r.id}
      labelOf={r => `${r.profile?.full_name ?? 'Player'}${r.status === 'pending' ? ' (invited)' : ''}`}
      // 44: each avatar is its own tap target (a tap shows the name).
      size={44}
      maxVisible={6}
      renderAvatar={(r, size) => {
        const p = r.profile as any;
        return (
          <View
            style={[
              styles.avatar,
              { width: size, height: size, backgroundColor: p?.avatar_bg_color || c.primaryLight },
              r.status === 'pending' && styles.invited,
            ]}
          >
            <Text style={t.title} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              {p?.avatar_emoji ?? (p?.full_name?.trim()[0]?.toUpperCase() || '?')}
            </Text>
          </View>
        );
      }}
    />
  );

  return (
    <SectionCard
      title="Players"
      count={count}
      open={open}
      onToggle={onToggle}
      collapsedContent={rosterShown.length > 0 ? pile : null}
      action={isPriv ? {
        label: 'Roles',
        onPress: () => navigation.navigate('TournamentMembers', { tournamentId, tournamentName: tournament.name }),
        a11yLabel: 'Manage player roles',
      } : undefined}
    >
      {rosterShown.length === 0 ? (
        <Text style={[t.hint, styles.empty]}>No one has joined yet.</Text>
      ) : rosterShown.map((r, i) => {
        const role = r.role as TournamentRole;
        const isInvitePending = r.status === 'pending';
        const name = r.profile?.full_name ?? 'Player';
        return (
          <TouchableOpacity
            key={r.id}
            style={[styles.row, i > 0 && { borderTopWidth: HAIRLINE, borderTopColor: c.border }]}
            onPress={() => navigation.navigate('PlayerProfile', { userId: r.user_id, userName: name })}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`${name}${isInvitePending ? ', invited' : ''}. Open profile`}
          >
            <Text style={[t.meta, styles.seed]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{i + 1}</Text>
            <FlairName
              name={name}
              nameColor={(r.profile as any)?.name_color}
              styleId={(r.profile as any)?.list_name_style_id ?? null}
              mode="list"
              numberOfLines={1}
              style={[t.title, styles.name, { color: isInvitePending ? c.textMuted : c.text }, isInvitePending && styles.italic]}
            />
            {isInvitePending ? (
              <Chip size="sm" label="Invited" tone="warning" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} />
            ) : role === 'admin' || role === 'co-admin' ? (
              <Chip size="sm" label={tournamentRoleLabel(role)} tone="brand" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} />
            ) : null}
            <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              {formatPlupr((r.profile as any)?.rating, (r.profile as any)?.total_matches_played)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  avatar: { borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
  invited: { opacity: 0.55 },
  row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  seed: { width: 20 },
  // Row title preset (15/700); invites keep the muted italic.
  name: { flex: 1, minWidth: 0 },
  italic: { fontStyle: 'italic' },
  empty: { paddingVertical: SPACE.sm },
});
