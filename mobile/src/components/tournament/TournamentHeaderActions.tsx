// TournamentDetail's header-right actions (plan section 5, slot 0): [Share]
// [Bookmark]. They used to sit in the quick-action row under the header card.
// Two icons leave room for the tournament name as the title on a 375pt phone.
// Same shape as LeagueHeaderActions: the app's own buttons, with the share
// pill turned into a borderless 44 box so it reads as a header action.
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import ShareLinkButton from '../ShareLinkButton';
import BookmarkButton from '../BookmarkButton';

export type TournamentHeaderActionsProps = {
  tournamentId: string;
  tournamentName: string;
  /** Registration is open: the share copy invites people in. */
  registrationOpen: boolean;
  /** Desktop web copies the link instead of opening a share sheet: confirm it. */
  onCopied: () => void;
};

export default function TournamentHeaderActions({
  tournamentId, tournamentName, registrationOpen, onCopied,
}: TournamentHeaderActionsProps) {
  return (
    <View style={styles.row}>
      {/* The tournament URL unfurls into the status/roster OG card. */}
      <ShareLinkButton
        url={`https://www.pickleague.club/tournaments/${tournamentId}`}
        title={tournamentName}
        message={registrationOpen
          ? `Registration is open for "${tournamentName}" on Pickleague`
          : `"${tournamentName}" on Pickleague`}
        onCopied={onCopied}
        style={styles.share}
      />
      <BookmarkButton targetType="tournament" targetId={tournamentId} size={20} style={styles.box} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  // Real 44x44 boxes: react-native-web ignores BookmarkButton's hitSlop.
  box: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  share: {
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    borderWidth: 0,
    backgroundColor: 'transparent',
    paddingHorizontal: SPACE.sm,
    paddingVertical: 0,
  },
});
