// LeagueDetail's header-right actions (plan section 5, slot 0): [Share] [Bookmark].
// They used to sit inside the description card. Two icons leave room for the
// league name as the title on a 375pt phone.
//
// Both reuse the app's existing buttons; the style passed here only turns the
// share pill into a borderless 44 box so it reads as a header action.
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import ShareLinkButton from '../ShareLinkButton';
import BookmarkButton from '../BookmarkButton';

export type LeagueHeaderActionsProps = {
  leagueId: string;
  leagueName: string;
  /** Desktop web copies the link instead of opening a share sheet: confirm it. */
  onCopied: () => void;
};

export default function LeagueHeaderActions({ leagueId, leagueName, onCopied }: LeagueHeaderActionsProps) {
  return (
    <View style={styles.row}>
      {/* The league URL unfurls into the roster/top-players OG card. */}
      <ShareLinkButton
        url={`https://www.pickleague.club/leagues/${leagueId}`}
        title={leagueName}
        message={`Join "${leagueName}" on Pickleague`}
        onCopied={onCopied}
        style={styles.share}
      />
      <BookmarkButton targetType="league" targetId={leagueId} size={20} style={styles.box} />
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
