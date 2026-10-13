// JOIN A LEAGUE (plan section 3, layout B): for an account in no league.
// [Enter code] and [Browse all ›], then 3 open leagues with a working inline
// [Join] (open) / [Request] (private) through useLeagueJoin, the one
// data-changing action allowed on Home (decision 1: joining never touches the
// ratings cascade). After a join, Home reloads and the league moves into YOURS.
//
// Rows name the league's COURT (LeagueRow uses displayCourtName), never a city.
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Panel, SectionHeader } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import type { UseLeagueJoin } from '../../lib/useLeagueJoin';
import LeagueRow, { LeagueJoinButton } from '../LeagueRow';
import type { HomeOpenLeague } from './homeData';

type Props = {
  leagues: HomeOpenLeague[];
  leagueJoin: UseLeagueJoin;
  /** Distance fact per league id ("2.1 mi"), only when location is already granted. */
  distanceById?: ReadonlyMap<string, string>;
  onEnterCode: () => void;
  onBrowse: () => void;
  onLeague: (l: HomeOpenLeague, position: number) => void;
  onJoinPressed: (kind: 'join' | 'request', position: number) => void;
};

export default function JoinLeagueSection({
  leagues,
  leagueJoin,
  distanceById,
  onEnterCode,
  onBrowse,
  onLeague,
  onJoinPressed,
}: Props) {
  return (
    <View>
      <SectionHeader title="Join a league" />
      <View style={styles.buttons}>
        <Button size="sm" variant="outline" title="Enter code" onPress={onEnterCode} style={styles.flex} />
        <Button size="sm" variant="outline" title="Browse all ›" onPress={onBrowse} style={styles.flex} />
      </View>
      {leagues.length > 0 ? (
        <Panel padded={false}>
          {leagues.map((l, i) => (
            <LeagueRow
              key={l.id}
              layout="row"
              league={l}
              role={null}
              memberCount={l.memberCount}
              facts={[distanceById?.get(l.id), l.inSeason && 'In season']}
              lastRow={i === leagues.length - 1}
              onPress={() => onLeague(l, i)}
              // `requested` goes to the button only: the row would otherwise
              // show a "Requested" chip next to the "Requested" label.
              action={
                <LeagueJoinButton
                  league={l}
                  leagueJoin={leagueJoin}
                  requested={l.requested}
                  onPressed={(kind) => onJoinPressed(kind, i)}
                />
              }
            />
          ))}
        </Panel>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: 'row', gap: SPACE.sm, marginBottom: SPACE.sm },
  flex: { flex: 1 },
});
