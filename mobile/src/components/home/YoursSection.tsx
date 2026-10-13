// YOURS (plan section 3): each of my leagues and live tournaments as one 56px
// row with ONE live fact (lib/agenda leagueLiveFact: open vote, then next
// event, then the season; "Wk 7/12" as the trailing badge). At most 4 rows,
// then "All yours (N) ›" opens Play with Mine on for that visit only; the
// header's "Find more ›" opens Play on Discover.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Panel, SectionHeader } from '@just-messin-around/expo-foundation/ui';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { YOURS_CAP, dayLabel, leagueLiveFact, shortTime } from '../../lib/agenda';
import LeagueRow from '../LeagueRow';
import TournamentRow from '../TournamentRow';
import type { HomeLeague, HomeTournament } from './homeData';

type Props = {
  leagues: HomeLeague[];
  tournaments: HomeTournament[];
  now: number;
  /** A league just joined from JOIN A LEAGUE: tinted so the eye follows it. */
  highlightId?: string | null;
  onLeague: (l: HomeLeague, position: number) => void;
  onTournament: (t: HomeTournament, position: number) => void;
  onFindMore: () => void;
  onAllYours: () => void;
};

function tournamentWhen(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${dayLabel(d, new Date(now))} ${shortTime(d)}`;
}

export default function YoursSection({
  leagues,
  tournaments,
  now,
  highlightId,
  onLeague,
  onTournament,
  onFindMore,
  onAllYours,
}: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const total = leagues.length + tournaments.length;
  const shownLeagues = leagues.slice(0, YOURS_CAP);
  const shownTournaments = tournaments.slice(0, Math.max(0, YOURS_CAP - shownLeagues.length));
  const shownCount = shownLeagues.length + shownTournaments.length;
  const more = total > shownCount;

  return (
    <View>
      <SectionHeader
        title="Yours"
        count={total}
        action={{ label: 'Find more ›', onPress: onFindMore, a11yLabel: 'Find more leagues and tournaments' }}
      />
      <Panel padded={false}>
        {shownLeagues.map((l, i) => {
          const fact = leagueLiveFact({ openVotes: l.openVotes, nextEventAt: l.nextEventAt, season: l.season }, now);
          return (
            <LeagueRow
              key={`l-${l.id}`}
              layout="row"
              league={l}
              role={l.role}
              // null fact = keep the built subtitle (the court).
              subtitle={fact.subtitle ?? undefined}
              trailingText={fact.trailing}
              highlighted={highlightId === l.id}
              lastRow={!more && i === shownCount - 1}
              onPress={() => onLeague(l, i)}
            />
          );
        })}
        {shownTournaments.map((tr, j) => {
          const i = shownLeagues.length + j;
          return (
            <TournamentRow
              key={`t-${tr.id}`}
              layout="row"
              tournament={{ id: tr.id, name: tr.name, location_name: tr.location_name, status: tr.status }}
              leagueName={tr.leagueName}
              facts={[tr.formatLabel]}
              myStatus={tr.myStatus}
              invited={tr.invited}
              chips={[tr.status === 'active' && { label: 'In progress', tone: 'success' }]}
              trailingText={tr.status === 'active' ? null : tournamentWhen(tr.startTime, now)}
              lastRow={!more && i === shownCount - 1}
              onPress={() => onTournament(tr, i)}
            />
          );
        })}
        {more ? (
          <TouchableOpacity
            style={styles.more}
            activeOpacity={0.6}
            onPress={onAllYours}
            accessibilityRole="button"
            accessibilityLabel={`All yours, ${total}`}
          >
            <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              All yours ({total}) ›
            </Text>
          </TouchableOpacity>
        ) : null}
      </Panel>
    </View>
  );
}

const styles = StyleSheet.create({
  more: { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACE.md },
});
